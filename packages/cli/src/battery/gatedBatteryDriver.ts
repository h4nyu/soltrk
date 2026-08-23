import { BatteryDriver, BatteryStatus } from "@soltrk/core";
import { SmartPlug, TuyaPlugConfig } from "@soltrk/tuya";

// Minimal shape GatedBatteryDriver needs from a plug - lets tests inject a
// fake instead of a real SmartPlug (which opens a TCP connection on every
// setOn() call).
export type PowerGate = { setOn(on: boolean): Promise<boolean> };

export function gatesBySn(plugs: TuyaPlugConfig[]): Map<string, PowerGate> {
  return new Map(plugs.map((plug) => [plug.gatesSn, new SmartPlug(plug)]));
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
export class GatedBatteryDriver implements BatteryDriver {
  private readonly forcedSns = new Set<string>();

  constructor(
    private readonly inner: BatteryDriver,
    private readonly plugsBySn: Map<string, PowerGate>,
    private readonly offWatts: number,
    private readonly criticalSocPercent: number,
    private readonly recoverySocPercent: number,
  ) {}

  getStatus(sn: string): Promise<BatteryStatus | undefined> {
    return this.inner.getStatus(sn);
  }

  async setChargeLimit(sn: string, watts: number, acOn?: boolean): Promise<boolean> {
    const plug = this.plugsBySn.get(sn);
    if (!plug) return this.inner.setChargeLimit(sn, watts);

    const status = await this.inner.getStatus(sn);
    const soc = status?.batterySoc;
    if (soc !== undefined) {
      if (soc <= this.criticalSocPercent) this.forcedSns.add(sn);
      else if (soc >= this.recoverySocPercent) this.forcedSns.delete(sn);
      // Between the two thresholds (or if soc is unknown this cycle): leave
      // whatever forced state was already in effect unchanged.
    }
    const critical = this.forcedSns.has(sn);
    if (critical) {
      console.warn(`[gated:${sn}] SOC ${soc}% forcing AC on regardless of solar/priority (releases at ${this.recoverySocPercent}%)`);
    }

    const gateOn = critical || (acOn ?? watts > this.offWatts);
    if (!(await plug.setOn(gateOn))) return false;
    if (!gateOn) return true;
    return this.inner.setChargeLimit(sn, watts);
  }
}
