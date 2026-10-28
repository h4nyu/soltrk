import { Series } from "./buckets";

export type EnergyTotals = {
  /** Everything the panels produced in the range. */
  generatedKwh: number;
  /** The part of it the house actually took, which is what displaces a bill. */
  usedKwh: number;
  yen: number;
};

const HOUR_MS = 3_600_000;

/**
 * Energy, and what it was worth, over an already-bucketed range.
 *
 * `since` narrows to a suffix of the same series, so today, this month and the
 * whole record can be answered from one pass over the samples instead of three
 * - which matters on the Pi, where a 60-day range is over a hundred thousand
 * of them. `until` is the same idea for the other edge, only needed for an
 * arbitrary caller-picked range (the seek bar's selection) rather than one of
 * the three that always run to "now".
 *
 * `usedKwh` rather than `generatedKwh` is what gets priced. With no export
 * payment, a watt the house does not take is a watt given away, so pricing
 * generation would flatter the number. In practice the two are almost the
 * same here - measured over the first three weeks, 98-100% of generation was
 * consumed, because an 880Wp array rarely out-runs a house drawing ~99W plus
 * whatever is charging - but the distinction matters on a bright day and costs
 * nothing to keep.
 *
 * The house figure used is `houseStandbyWatts`, the control loop's own
 * constant, which is deliberately set *below* what the house really draws (70
 * against a measured 99) so the loop biases towards importing. Reusing it here
 * therefore understates consumption and overstates what was given away, which
 * is the right direction for a savings claim to err in - and it avoids a second
 * house-load number that could drift away from the first.
 *
 * A bucket with no samples contributes nothing rather than being interpolated,
 * so an outage reads as no generation instead of inventing some.
 *
 * Charging draw comes from the series' own global `acIn` - the same total
 * each cycle already carries as `totalAcInputWatts` - rather than summed back
 * up from `s.devices`. The two are the same number, but the global field
 * keeps working for a range with no per-device breakdown at all: past the raw
 * retention window, a summarised day keeps only the three global totals, not
 * a per-device split (see cli/summary.ts's `Day`).
 */
export const energyOf = (
  s: Series,
  opts: { houseStandbyWatts: number; yenPerKwh: number; since?: number; until?: number },
): EnergyTotals => {
  let generatedWh = 0;
  let usedWh = 0;
  const hours = s.bucketMs / HOUR_MS;
  const since = opts.since ?? Number.NEGATIVE_INFINITY;
  const until = opts.until ?? Number.POSITIVE_INFINITY;

  for (let i = 0; i < s.t.length; i += 1) {
    if (s.t[i] < since || s.t[i] >= until) continue;
    const solar = s.solar[i];
    if (solar === null) continue;
    generatedWh += solar * hours;

    const acIn = s.acIn[i] ?? 0;
    usedWh += Math.min(solar, opts.houseStandbyWatts + acIn) * hours;
  }

  const usedKwh = usedWh / 1000;
  return {
    generatedKwh: generatedWh / 1000,
    usedKwh,
    yen: usedKwh * opts.yenPerKwh,
  };
};

/**
 * Start of the current local day and month, as UTC instants.
 *
 * Plain `Date` local methods are the local zone here because the container is
 * given `TZ` - the same arrangement the writer relies on for deciding which
 * daily file a record belongs to. Values stay UTC; only these boundaries are
 * local.
 */
export const periodStarts = (now: Date): { day: number; month: number } => {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const month = new Date(day.getFullYear(), day.getMonth(), 1, 0, 0, 0, 0);
  return { day: day.getTime(), month: month.getTime() };
};
