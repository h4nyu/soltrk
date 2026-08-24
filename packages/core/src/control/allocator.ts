// Real hardware overhead observed between a requested charge wattage and
// the AC input it actually draws (e.g. a 299W request measured drawing
// ~332W) - conversion loss intrinsic to the hardware, not a configurable
// knob.
const CHARGE_CONVERSION_OVERHEAD_WATTS = 33;

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
 * Balance-evaluation charging: there's no fixed charge order between
 * devices - whichever non-full (SOC < 100%) device would leave the overall
 * grid balance closest to zero (without backfeeding) is switched on this
 * cycle. A battery that never gets its turn here can't actually run dry:
 * that's GatedBatteryDriver's job (a critical-SOC rescue forces its plug
 * open regardless of what this function decides), so this function is free
 * to optimize purely for solar utilization rather than fairness - a device
 * with little or no load of its own naturally reaches 100% quickly and
 * drops out of contention, handing the turn to whoever's next.
 *
 * For each candidate `sn`, the achievable request is:
 *
 *   remainingWatts = netWatts - (every *other* device's measured AC input)
 *   requestWatts   = remainingWatts - acOutputWattsBySn[sn] - CHARGE_CONVERSION_OVERHEAD_WATTS
 *
 * `acOutputWattsBySn[sn]` is `sn`'s own household load - measured directly
 * from the battery's telemetry regardless of whether its AC input is
 * currently on, so it's known for every candidate up front. Switching `sn`
 * on would draw `requestWatts + acOutputWattsBySn[sn] +
 * CHARGE_CONVERSION_OVERHEAD_WATTS` in total (the requested charge current,
 * plus its own load passing through, plus the fixed conversion loss) - a
 * candidate is only feasible if that fits within `remainingWatts` at all
 * (i.e. `requestWatts >= limits.min`), and among feasible candidates the one
 * with the least leftover (closest to zero balance) wins, since that's the
 * one making the fullest use of the available solar. Whenever nothing else
 * is drawing, every feasible candidate reaches the same (zero) balance
 * regardless of its own load - the request just absorbs whatever's left
 * over - so ties are broken toward the lowest `acOutputWattsBySn`: more of
 * its charge current goes into the battery rather than passing straight
 * through, so it reaches 100% (and hands off) sooner. Subtracting other
 * devices' *measured* input (not the candidate's own) keeps this
 * self-correcting without the self-feedback oscillation that made us avoid
 * measured-input control for a device's own request.
 *
 * AC gate (`acOn`): a device is connected to AC when it wins the evaluation
 * above, or when it's full (SOC 100%) while there's any solar at all - a
 * full unit doesn't charge, but with AC present it passes solar through to
 * its own load instead of draining its battery, which both saves a full
 * battery from cycling 99⇄100 all afternoon (plug flapping every few minutes
 * as it self-discharges) and feeds that load from solar. Passthrough isn't
 * held to minToCharge the way a new charge candidate is - it only ever
 * draws what the load actually needs, so even solar too weak to be worth
 * starting a fresh charge session over is still worth passing through.
 * Everything else is disconnected. The critical-SOC rescue in
 * GatedBatteryDriver can override a "false" to keep a near-empty battery
 * alive - that decision needs
 * per-device forced-state and stays there.
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
  sns: string[],
  socBySn: Record<string, number | undefined>,
  acInputWattsBySn: Record<string, number | undefined>,
  acOutputWattsBySn: Record<string, number | undefined>,
  availableWatts: number,
  limits: AllocatorLimits,
): Allocation {
  const watts: Record<string, number> = {};
  const acOn: Record<string, boolean> = {};
  for (const sn of sns) {
    watts[sn] = limits.min;
    acOn[sn] = false;
  }

  const netWatts = Math.max(0, availableWatts - limits.houseStandbyWatts);

  // Full devices pass whatever solar there is straight through to their own
  // load - unlike starting a new charge (which has a real minimum draw, see
  // minToCharge below), passthrough only ever draws exactly what the load
  // needs, so there's no minimum solar required for it to be worthwhile.
  if (netWatts > 0) {
    for (const sn of sns) {
      if (socBySn[sn] === 100) acOn[sn] = true;
    }
  }

  if (netWatts < limits.minToCharge) return { watts, acOn };

  const candidates = sns.filter((sn) => {
    const soc = socBySn[sn];
    return soc !== undefined && soc < 100;
  });

  let best: { sn: string; requestWatts: number; balance: number; ownLoad: number } | undefined;
  for (const sn of candidates) {
    const otherInputWatts = sns
      .filter((other) => other !== sn)
      .reduce((sum, other) => sum + (acInputWattsBySn[other] ?? 0), 0);
    const remainingWatts = netWatts - otherInputWatts;
    const ownLoad = acOutputWattsBySn[sn] ?? 0;
    const requestWatts = remainingWatts - ownLoad - CHARGE_CONVERSION_OVERHEAD_WATTS;
    if (requestWatts < limits.min) continue;
    const clampedWatts = Math.min(requestWatts, limits.max);
    const balance = remainingWatts - (clampedWatts + ownLoad + CHARGE_CONVERSION_OVERHEAD_WATTS);
    // Whenever nothing else is drawing, every feasible candidate reaches the
    // same (zero) balance - the request just absorbs whatever's left over
    // regardless of load. Break that tie toward the lowest own load: more of
    // its charge current goes into the battery rather than passing straight
    // through, so it reaches 100% (and hands off to the next candidate)
    // sooner.
    if (!best || balance < best.balance || (balance === best.balance && ownLoad < best.ownLoad)) {
      best = { sn, requestWatts: clampedWatts, balance, ownLoad };
    }
  }
  if (!best) return { watts, acOn };

  watts[best.sn] = best.requestWatts;
  acOn[best.sn] = true;
  return { watts, acOn };
}
