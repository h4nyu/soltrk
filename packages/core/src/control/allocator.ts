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
 * `socBySn`) - capped at the current solar `netWatts`, not just at
 * `limits.max`. Without that solar cap the ramp would keep climbing every
 * cycle toward `limits.max` (1200W) even when solar is much lower (e.g.
 * 300W), overshooting into needless grid draw - exactly what ramping was
 * meant to avoid in the first place. Real hardware doesn't reliably obey a
 * specific requested wattage (observed drawing 137W against a 100W
 * request), so asking for the full solar amount outright when it's only
 * barely above the threshold would still mean needlessly drawing more from
 * the grid than necessary; ramping toward that (now correct) ceiling avoids
 * that overshoot. Basing the ramp on the real measured input rather than
 * remembering our own last request is self-correcting: if the device
 * didn't actually respond to what we asked last cycle, the next step still
 * starts from wherever it really is now, not from a stale assumption.
 * Going back to `min` is instant, not ramped, the moment solar drops or the
 * active device changes - only the upward direction risks over-drawing, so
 * only that direction is throttled.
 *
 * Every other device gets `limits.min` - the lowest charge rate the
 * hardware supports, since real Anker hardware has no true "0W/off" via
 * this command (below-minimum requests just get clamped up to it by the
 * firmware, see README). This is still safe against backfeed even while
 * ramping: over-consumption only means extra grid draw, not export - only
 * under-consumption risks backfeed, and the ramp only ever asks for more
 * than the device is currently drawing, never less (up to the solar
 * ceiling). A device with unknown SOC (status read failed) is skipped, not
 * assumed full or empty, so we don't get stuck stalling behind an
 * unreachable unit.
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
  const ceiling = Math.min(netWatts, limits.max);
  result[activeSn] = Math.max(limits.min, Math.min(currentInput + limits.rampStepWatts, ceiling));
  return result;
}
