export type AllocatorLimits = {
  min: number;
  max: number;
  minToCharge: number;
  // Constant floor on house consumption that's safe to assume is always
  // drawn - that much of solar never needs covering by the charger.
  houseStandbyWatts: number;
  // Watts to add per cycle while ramping the active device up toward `max`
  // (see below) - typically `(max - min) / N` for some target ramp duration
  // in cycles.
  rampStepWatts: number;
};

/**
 * Sequential priority charging: whenever there's enough solar (net of the
 * guaranteed house standby load) to bother, the highest priority device
 * that isn't full yet (SOC < 100%) is asked to charge, ramping up by
 * `limits.rampStepWatts` per cycle from its *actual currently measured* AC
 * input (`currentInputWattsBySn`, from the same telemetry already read for
 * `socBySn`) rather than jumping straight to `limits.max` - real hardware
 * doesn't reliably obey a specific requested wattage (observed drawing 137W
 * against a 100W request), so asking for `max` outright when solar is only
 * barely above the threshold would mean needlessly drawing far more from
 * the grid than necessary. Basing the ramp on the real measured input
 * rather than remembering our own last request is self-correcting: if the
 * device didn't actually respond to what we asked last cycle, the next
 * step still starts from wherever it really is now, not from a stale
 * assumption. Going back to `min` is instant, not ramped, the moment solar
 * drops or the active device changes - only the upward direction risks
 * over-drawing, so only that direction is throttled.
 *
 * Every other device gets `limits.min` - the lowest charge rate the
 * hardware supports, since real Anker hardware has no true "0W/off" via
 * this command (below-minimum requests just get clamped up to it by the
 * firmware, see README). This is still safe against backfeed even while
 * ramping: over-consumption only means extra grid draw, not export - only
 * under-consumption risks backfeed, and the ramp only ever asks for more
 * than the device is currently drawing, never less. A device with unknown
 * SOC (status read failed) is skipped, not assumed full or empty, so we
 * don't get stuck stalling behind an unreachable unit.
 */
export function allocate(
  prioritySns: string[],
  socBySn: Record<string, number | undefined>,
  currentInputWattsBySn: Record<string, number | undefined>,
  availableWatts: number,
  limits: AllocatorLimits,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const sn of prioritySns) result[sn] = limits.min;

  const netWatts = Math.max(0, availableWatts - limits.houseStandbyWatts);
  if (netWatts < limits.minToCharge) return result;

  const activeSn = prioritySns.find((sn) => {
    const soc = socBySn[sn];
    return soc !== undefined && soc < 100;
  });
  if (!activeSn) return result;

  const currentInput = currentInputWattsBySn[activeSn] ?? limits.min;
  result[activeSn] = Math.min(currentInput + limits.rampStepWatts, limits.max);
  return result;
}
