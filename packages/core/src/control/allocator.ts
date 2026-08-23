export type AllocatorLimits = {
  min: number;
  max: number;
  minToCharge: number;
  // Constant floor on house consumption that's safe to assume is always
  // drawn - that much of solar never needs covering by the charger.
  houseStandbyWatts: number;
};

/**
 * Sequential priority charging: whenever there's enough solar (net of the
 * guaranteed house standby load) to bother, the highest priority device
 * that isn't full yet (SOC < 100%) is asked to charge at the current solar
 * output, capped at `limits.max`. This used to ramp up gradually instead of
 * jumping straight there, to avoid needlessly over-asking while hardware
 * caught up - but capping at solar output already bounds the request to
 * what's actually available, so the gradual step added lag without much
 * extra safety once that cap was in place, and real solar changes gradually
 * enough on its own (see session notes) that a ramp wasn't buying anything.
 *
 * Every other device gets `limits.min` - the lowest charge rate the
 * hardware supports, since real Anker hardware has no true "0W/off" via
 * this command (below-minimum requests just get clamped up to it by the
 * firmware, see README). Real hardware doesn't reliably obey a specific
 * requested wattage either way (observed drawing 137W against a 100W
 * request) - this is safe against backfeed regardless: over-consumption
 * only means extra grid draw, not export, and under-consumption (if
 * hardware draws less than asked) is an accepted, bounded risk rather than
 * something worth adding an artificial margin to chase, given the poll
 * cycle itself already means solar changes are only reacted to after the
 * fact. A device with unknown SOC (status read failed) is skipped, not
 * assumed full or empty, so we don't get stuck stalling behind an
 * unreachable unit.
 */
export function allocate(
  prioritySns: string[],
  socBySn: Record<string, number | undefined>,
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

  result[activeSn] = Math.max(limits.min, Math.min(netWatts, limits.max));
  return result;
}
