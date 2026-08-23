export interface AllocatorLimits {
  min: number;
  max: number;
  step: number;
  minToCharge: number;
  // Constant floor on house consumption that's safe to assume is always
  // drawn - that much of solar never needs covering by the charger.
  houseStandbyWatts: number;
}

/**
 * Sequential priority charging: all available solar watts (net of the
 * guaranteed house standby load) go to the highest priority device that
 * isn't full yet (SOC < 100%); every other device gets an explicit 0 so it
 * doesn't also trickle-charge from the grid in parallel. A device with
 * unknown SOC (status read failed) is skipped, not assumed full or empty, so
 * we don't get stuck stalling behind an unreachable unit.
 */
export function allocate(
  prioritySns: string[],
  socBySn: Record<string, number | undefined>,
  availableWatts: number,
  limits: AllocatorLimits,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const sn of prioritySns) result[sn] = 0;

  const netWatts = Math.max(0, availableWatts - limits.houseStandbyWatts);
  if (netWatts < limits.minToCharge) return result;

  const activeSn = prioritySns.find((sn) => {
    const soc = socBySn[sn];
    return soc !== undefined && soc < 100;
  });
  if (!activeSn) return result;

  // Round UP to the step: the charger must draw at least as much as
  // netWatts for the "no backfeed" guarantee to hold even if the house is
  // drawing nothing beyond its guaranteed standby load (flooring could leave
  // up to `step` watts of solar unconsumed, which would export in that case).
  const stepped = Math.ceil(netWatts / limits.step) * limits.step;
  result[activeSn] = Math.min(Math.max(stepped, limits.min), limits.max);
  return result;
}
