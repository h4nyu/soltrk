export type AllocatorLimits = {
  min: number;
  max: number;
  minToCharge: number;
  // Constant floor on house consumption that's safe to assume is always
  // drawn - that much of solar never needs covering by the charger.
  houseStandbyWatts: number;
};

export type Allocation = {
  // Requested charge wattage per sn (min..max - the hardware has no true 0).
  watts: Record<string, number>;
  // Whether each device should be connected to AC at all this cycle - the
  // physical smart-plug decision for gated devices (an ungated device has no
  // way to act on "false" and just ignores this).
  acOn: Record<string, boolean>;
};

/**
 * Sequential priority charging: whenever there's enough solar (net of the
 * guaranteed house standby load) to bother, the highest priority device
 * that isn't full yet (SOC < 100%) is asked to charge at the current solar
 * output *minus what every other battery is already measured to be
 * drawing* (`acInputWattsBySn`), capped at `limits.max`. Normally the
 * other batteries' plugs are cut and that subtraction is zero - but during
 * a critical-SOC rescue (see GatedBatteryDriver) deprioritized units are
 * force-charging at ~`limits.min` each, and full units passing solar
 * through to their loads (below) also consume - that input has already
 * spoken for part (or all) of the solar, so without the subtraction the
 * active unit would be asked for the full solar amount on top, widening
 * the grid draw for no benefit. Subtracting *measured* input keeps this
 * self-correcting, and since it's the other units' consumption - not the
 * active unit's own - it doesn't create the self-feedback oscillation that
 * made us avoid measured-input control for the active unit itself.
 *
 * AC gate (`acOn`): a device is connected to AC when it's the active
 * charging target, or when it's full (SOC 100%) while solar is sufficient
 * - a full unit doesn't charge, but with AC present it passes solar
 * through to its own load instead of draining its battery, which both
 * saves a full battery from cycling 99⇄100 all afternoon (plug flapping
 * every few minutes as it self-discharges) and feeds that load from solar.
 * Everything else is disconnected. The critical-SOC rescue in
 * GatedBatteryDriver can override a "false" to keep a near-empty battery
 * alive - that decision needs per-device forced-state and stays there.
 *
 * Every device's requested wattage is at least `limits.min` - the lowest
 * request the hardware accepts (below-minimum requests get clamped up by
 * the firmware, see README). Real hardware doesn't reliably obey the
 * requested wattage anyway (observed drawing 137W against a 100W request)
 * - this is safe against backfeed regardless: over-consumption only means
 * extra grid draw, not export, and under-consumption is an accepted,
 * bounded risk given the poll cycle already means solar changes are only
 * reacted to after the fact. A device with unknown SOC (status read
 * failed) is skipped, not assumed full or empty, so we don't get stuck
 * stalling behind an unreachable unit.
 */
export function allocate(
  prioritySns: string[],
  socBySn: Record<string, number | undefined>,
  acInputWattsBySn: Record<string, number | undefined>,
  availableWatts: number,
  limits: AllocatorLimits,
): Allocation {
  const watts: Record<string, number> = {};
  const acOn: Record<string, boolean> = {};
  for (const sn of prioritySns) {
    watts[sn] = limits.min;
    acOn[sn] = false;
  }

  const netWatts = Math.max(0, availableWatts - limits.houseStandbyWatts);
  if (netWatts < limits.minToCharge) return { watts, acOn };

  // Solar is sufficient: full devices stay connected for passthrough.
  for (const sn of prioritySns) {
    if (socBySn[sn] === 100) acOn[sn] = true;
  }

  const activeSn = prioritySns.find((sn) => {
    const soc = socBySn[sn];
    return soc !== undefined && soc < 100;
  });
  if (!activeSn) return { watts, acOn };

  const otherInputWatts = prioritySns
    .filter((sn) => sn !== activeSn)
    .reduce((sum, sn) => sum + (acInputWattsBySn[sn] ?? 0), 0);
  const remainingWatts = netWatts - otherInputWatts;
  watts[activeSn] = Math.max(limits.min, Math.min(remainingWatts, limits.max));
  acOn[activeSn] = true;
  return { watts, acOn };
}
