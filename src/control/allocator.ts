export interface AllocatorLimits {
  min: number;
  max: number;
  step: number;
  minToCharge: number;
}

/**
 * Sequential priority charging: all available solar watts go to the highest
 * priority device that isn't full yet (SOC < 100%); every other device gets
 * an explicit 0 so it doesn't also trickle-charge from the grid in parallel.
 * A device with unknown SOC (status read failed) is skipped, not assumed full
 * or empty, so we don't get stuck stalling behind an unreachable unit.
 */
export function allocate(
  prioritySns: string[],
  socBySn: Record<string, number | undefined>,
  availableWatts: number,
  limits: AllocatorLimits,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const sn of prioritySns) result[sn] = 0;

  if (availableWatts < limits.minToCharge) return result;

  const activeSn = prioritySns.find((sn) => {
    const soc = socBySn[sn];
    return soc !== undefined && soc < 100;
  });
  if (!activeSn) return result;

  const stepped = Math.floor(availableWatts / limits.step) * limits.step;
  result[activeSn] = Math.min(Math.max(stepped, limits.min), limits.max);
  return result;
}
