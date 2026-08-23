import { BatteryDriver, BatteryStatus, Result } from "@soltrk/core";
import { TuyaPlugConfig, SmartPlug } from "@soltrk/tuya";

// Minimal shape the gated driver needs from a plug - lets tests inject a
// fake instead of a real smart plug (which opens a TCP connection on every
// setOn() call).
export type PowerGate = { setOn(on: boolean): Promise<Result<void>> };

export function gatesBySn(plugs: TuyaPlugConfig[]): Map<string, PowerGate> {
  return new Map(plugs.map((plug) => [plug.gatesSn, SmartPlug({ config: plug })]));
}

/**
 * Wraps a BatteryDriver with physical Tuya smart plugs wired in series with
 * a gated battery's AC input cable - a hard on/off cutoff that doesn't
 * depend on the Anker device's own charge-limit command or TOU schedule,
 * both of which have proven unreliable for actually stopping AC charging
 * (see the main README's "Known caveats"). A battery with no plug
 * configured for its sn just passes through to `inner` unchanged, so this
 * can wrap every Anker device and only the ones with a
 * TUYA_PLUG_*_GATES_SN entry actually get gated.
 *
 * The plug follows the allocator's `acOn` decision (active charging target,
 * or full-with-solar passthrough - see @soltrk/core/control/allocator.ts).
 * When `acOn` isn't provided (a caller not using the allocator), it falls
 * back to inferring from the wattage: on only when more than `offWatts`
 * (the allocator's `chargeLimitMin`, what deprioritized devices are sent)
 * was requested.
 *
 * Safety override: unlike a plain "anker" device, a gated one can be cut off
 * from AC entirely (no solar, deprioritized) with nothing to stop its own
 * battery draining down to zero powering whatever it's plugged into (e.g.
 * an actual refrigerator) - so at/below `criticalSocPercent`, the gate opens
 * and charges at whatever wattage was requested (normally `offWatts`, i.e.
 * the hardware's own minimum) regardless of solar availability or priority.
 * It stays forced open until SOC recovers to `recoverySocPercent` (a higher
 * threshold, not the same one) rather than immediately releasing at
 * `criticalSocPercent` again - without that gap, a SOC hovering right at the
 * critical line would flip the plug on/off every single poll cycle.
 * This state is tracked per sn in `forcedSns`, since the decision depends on
 * *why* the gate was opened last time (forced vs. normal priority), not just
 * the current request in isolation - and this method must be called every
 * cycle regardless of whether the request changed (see loop.ts) for the
 * check to actually run.
 */
export const GatedBatteryDriver = (props: {
  inner: BatteryDriver;
  plugsBySn: Map<string, PowerGate>;
  offWatts: number;
  criticalSocPercent: number;
  recoverySocPercent: number;
}): BatteryDriver => {
  const { inner, plugsBySn, offWatts, criticalSocPercent, recoverySocPercent } = props;
  const forcedSns = new Set<string>();

  const getStatus: BatteryDriver["getStatus"] = (sn) => inner.getStatus(sn);

  const setChargeLimit: BatteryDriver["setChargeLimit"] = async (sn, watts, acOn) => {
    const plug = plugsBySn.get(sn);
    if (!plug) return inner.setChargeLimit(sn, watts);

    const status = await inner.getStatus(sn);
    const soc = status instanceof Error ? undefined : status.batterySoc;
    if (soc !== undefined) {
      if (soc <= criticalSocPercent) forcedSns.add(sn);
      else if (soc >= recoverySocPercent) forcedSns.delete(sn);
      // Between the two thresholds (or if soc is unknown this cycle):
      // leave whatever forced state was already in effect unchanged.
    }
    const critical = forcedSns.has(sn);
    if (critical) {
      console.warn(
        `[gated:${sn}] SOC ${soc}% forcing AC on regardless of solar/priority (releases at ${recoverySocPercent}%)`,
      );
    }

    const gateOn = critical || (acOn ?? watts > offWatts);
    const gateResult = await plug.setOn(gateOn);
    if (gateResult instanceof Error) return gateResult;
    if (!gateOn) return undefined;
    return inner.setChargeLimit(sn, watts);
  };

  return { getStatus, setChargeLimit };
};
