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
 * `offWatts` should match the allocator's `chargeLimitMin` - the exact
 * value deprioritized devices are always sent (see
 * @soltrk/core/control/allocator.ts) - so the gate opens only for the one
 * device actually chosen to charge this cycle. This assumes the active
 * device is never itself assigned exactly `offWatts`, which holds today
 * because `minSolarToChargeWatts` (150W) exceeds `chargeLimitStep` (100W);
 * lowering minSolarToChargeWatts below chargeLimitStep would break that
 * assumption.
 */
export class GatedBatteryDriver implements BatteryDriver {
  constructor(
    private readonly inner: BatteryDriver,
    private readonly plugsBySn: Map<string, PowerGate>,
    private readonly offWatts: number,
  ) {}

  getStatus(sn: string): Promise<BatteryStatus | undefined> {
    return this.inner.getStatus(sn);
  }

  async setChargeLimit(sn: string, watts: number): Promise<boolean> {
    const plug = this.plugsBySn.get(sn);
    if (!plug) return this.inner.setChargeLimit(sn, watts);

    const shouldCharge = watts > this.offWatts;
    if (!(await plug.setOn(shouldCharge))) return false;
    if (!shouldCharge) return true;
    return this.inner.setChargeLimit(sn, watts);
  }
}
