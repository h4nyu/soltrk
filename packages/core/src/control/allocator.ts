// Real hardware overhead observed between a requested charge wattage and
// the AC input it actually draws (e.g. a 299W request measured drawing
// ~332W) - conversion loss intrinsic to the hardware, not a configurable
// knob.
const CHARGE_CONVERSION_OVERHEAD_WATTS = 33;

// Per point of SOC below 100%, how much of a virtual watt bonus a candidate
// gets when ranked against others (see allocate()'s docstring) - lets a
// low-SOC device outrank (and, if needed, outright win despite a nominally
// infeasible request from) a candidate that's already drawing most of the
// solar, without waiting for that incumbent to finish or for the hard
// critical-SOC floor in GatedBatteryDriver to kick in.
const SOC_URGENCY_BONUS_WATTS_PER_PERCENT = 3;

// Flat virtual watt bonus for whichever candidate won the *previous* cycle
// (see `previousActiveSn`) - without this, two candidates within about 10
// points of SOC of each other (10 * SOC_URGENCY_BONUS_WATTS_PER_PERCENT)
// can flip the win back and forth every single cycle as their SOCs and
// measured input tick past each other, physically toggling a gated
// device's smart plug (and paying CHARGE_CONVERSION_OVERHEAD_WATTS again on
// every switch) far more often than useful. A challenger needs a clearly
// better case, not just a marginally better one, to actually take over.
const STICKY_INCUMBENT_BONUS_WATTS = 30;

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
  // Diagnostic only: each feasible candidate's ranking score this cycle
  // (lower wins - see the docstring below). Omitted for anything that
  // wasn't a feasible candidate (full, unknown SOC, or infeasible even with
  // its urgency bonus) - present for the winner and every candidate it beat.
  scores: Record<string, number>;
  // Which candidate (if any) won this cycle's balance evaluation - distinct
  // from acOn, which is also true for any full device passing solar
  // through. Feed this back in as the next call's `previousActiveSn` to
  // give it a sticky incumbent bonus (see STICKY_INCUMBENT_BONUS_WATTS) and
  // avoid chattering between two closely-matched candidates.
  activeSn: string | undefined;
};

/**
 * Balance-evaluation charging: there's no fixed charge order between
 * devices - whichever non-full (SOC < 100%) device would leave the overall
 * grid balance closest to zero (without backfeeding), after weighting for
 * how low its own SOC is, is switched on this cycle. A battery that never
 * gets its turn here can't actually run dry: that's GatedBatteryDriver's
 * job (a critical-SOC rescue forces its plug open regardless of what this
 * function decides) - but waiting all the way for that hard floor was
 * observed leaving a device sitting neglected for an hour-plus at a
 * uncomfortably low SOC while a peer that had *already* recovered from its
 * own critical rescue kept winning purely on solar-utilization efficiency
 * (see SOC_URGENCY_BONUS_WATTS_PER_PERCENT below). A device with little or
 * no load of its own still naturally reaches 100% quickly and drops out of
 * contention on its own, handing the turn to whoever's next.
 *
 * For each candidate `sn`, the achievable request is:
 *
 *   remainingWatts = netWatts - (every *other* device's measured AC input)
 *   requestWatts   = remainingWatts - acOutputWattsBySn[sn] - CHARGE_CONVERSION_OVERHEAD_WATTS
 *   urgencyBonus   = SOC_URGENCY_BONUS_WATTS_PER_PERCENT * (100 - soc)
 *
 * `acOutputWattsBySn[sn]` is `sn`'s own household load - measured directly
 * from the battery's telemetry regardless of whether its AC input is
 * currently on, so it's known for every candidate up front. A candidate is
 * feasible if `requestWatts + urgencyBonus >= limits.min` - the bonus can
 * make a candidate feasible (and win) even when the raw math says every
 * watt of solar is already spoken for by a peer's measured draw, precisely
 * for the scenario above: a low-SOC device shouldn't have to wait for a
 * well-charged peer to finish before getting a look-in. When that happens,
 * the actual request sent is still just `limits.min` (clamped up from
 * whatever negative number the raw math produced) - the bonus only ever
 * affects *who* wins, never how many watts get requested beyond what the
 * real numbers justify, so a winning low-SOC candidate costs at most a
 * temporary bit of extra grid draw (self-correcting again next cycle) as
 * measured input catches up, the same accepted tradeoff already made for
 * hardware not obeying requested wattage precisely (see below). Among
 * feasible candidates, the one with the lowest `balance - urgencyBonus`
 * wins, since that's the fullest use of solar once urgency is accounted
 * for; ties are broken toward the lowest `acOutputWattsBySn`, so more of
 * its charge current goes into the battery rather than passing straight
 * through and it reaches 100% (handing off) sooner. Subtracting other
 * devices' *measured* input (not the candidate's own) keeps this
 * self-correcting without the self-feedback oscillation that made us avoid
 * measured-input control for a device's own request.
 *
 * AC gate (`acOn`): solar covers household loads before it charges
 * anything. Every unit with a load of its own is connected while there's
 * solar left to cover that load - emptiest battery first, so if there
 * isn't enough to go around, the units with the least charge to spare are
 * the ones that stop discharging. A full unit is always connected while
 * there's any solar (it can't charge, and cutting it makes it discharge to
 * 99% and flap the plug straight back on). Passthrough isn't held to
 * minToCharge the way a new charge candidate is - it only ever draws what
 * the load actually needs, so even solar too weak to start a charge with
 * is worth passing through.
 *
 * Covering loads first is not a concession by the charger: the watts it
 * gives up are watts the other units would otherwise have taken out of
 * their own batteries, so the net energy stored across the system is the
 * same either way - minus a full discharge/recharge round trip of
 * conversion loss and cycle wear that simply doesn't happen.
 *
 * Everything else is disconnected and runs off its own battery. The
 * critical-SOC rescue in GatedBatteryDriver can override that to keep a
 * near-empty battery alive - that decision needs per-device forced state
 * and stays there.
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
 *
 * `previousActiveSn` (the caller's own last `activeSn`, fed straight back
 * in) gets a flat STICKY_INCUMBENT_BONUS_WATTS on top of its urgency bonus,
 * so a challenger has to be clearly better, not just marginally ahead, to
 * take over - otherwise two evenly matched candidates could flip the winner
 * every single cycle.
 */
export function allocate(
  sns: string[],
  socBySn: Record<string, number | undefined>,
  acInputWattsBySn: Record<string, number | undefined>,
  acOutputWattsBySn: Record<string, number | undefined>,
  availableWatts: number,
  limits: AllocatorLimits,
  previousActiveSn?: string,
): Allocation {
  const watts: Record<string, number> = {};
  const acOn: Record<string, boolean> = {};
  for (const sn of sns) {
    watts[sn] = limits.min;
    acOn[sn] = false;
  }

  const netWatts = Math.max(0, availableWatts - limits.houseStandbyWatts);

  // Solar covers household loads before it charges anything. A unit whose
  // own load is fed from AC isn't draining its battery to run it, and isn't
  // paying to store that energy and retrieve it again later - so covering
  // loads first and charging with the remainder stores the same net watts
  // as charging hard while the others discharge, minus a whole round trip
  // of conversion losses and cycle wear. Unlike starting a charge (which
  // has a real minimum draw, see minToCharge), passthrough only ever draws
  // exactly what the load needs, so there's no minimum solar for it to be
  // worth doing.
  let loadBudget = netWatts;
  if (netWatts > 0) {
    // A full unit stays on whatever the budget says: it can't charge, so
    // AC costs nothing beyond its own load, and cutting it makes it
    // discharge to 99% and flap the plug back on moments later.
    for (const sn of sns) {
      if (socBySn[sn] === 100) {
        acOn[sn] = true;
        loadBudget -= acOutputWattsBySn[sn] ?? 0;
      }
    }
    // Then whatever solar is left covers the rest, emptiest battery first,
    // so when there isn't enough to go around the units with the least
    // charge to spare are the ones that stop discharging. A unit with no
    // load of its own is skipped - there's nothing to cover, and closing
    // its plug would only add needless switching.
    const byEmptiest = sns
      .filter((sn) => socBySn[sn] !== undefined && socBySn[sn] !== 100)
      .sort((a, b) => (socBySn[a] as number) - (socBySn[b] as number));
    for (const sn of byEmptiest) {
      const load = acOutputWattsBySn[sn] ?? 0;
      if (load > 0 && load <= loadBudget) {
        acOn[sn] = true;
        loadBudget -= load;
      }
    }
  }

  if (netWatts < limits.minToCharge) return { watts, acOn, scores: {}, activeSn: undefined };

  const candidates = sns.filter((sn) => {
    const soc = socBySn[sn];
    return soc !== undefined && soc < 100;
  });

  const scores: Record<string, number> = {};
  let best: { sn: string; requestWatts: number; score: number; ownLoad: number } | undefined;
  for (const sn of candidates) {
    const otherInputWatts = sns
      .filter((other) => other !== sn)
      .reduce((sum, other) => sum + (acInputWattsBySn[other] ?? 0), 0);
    const remainingWatts = netWatts - otherInputWatts;
    const ownLoad = acOutputWattsBySn[sn] ?? 0;
    const requestWatts = remainingWatts - ownLoad - CHARGE_CONVERSION_OVERHEAD_WATTS;
    // socBySn[sn] is always defined here - sn came from `candidates`, which
    // already filtered out undefined SOCs.
    const urgencyBonus = SOC_URGENCY_BONUS_WATTS_PER_PERCENT * (100 - (socBySn[sn] as number));
    const stickyBonus = sn === previousActiveSn ? STICKY_INCUMBENT_BONUS_WATTS : 0;
    const totalBonus = urgencyBonus + stickyBonus;
    if (requestWatts + totalBonus < limits.min) continue;
    // balance is computed from the max-only clamp (never the hardware
    // floor) so it stays a pure efficiency signal - 0 whenever requestWatts
    // fits under limits.max (the common case, by construction: remainingWatts
    // minus requestWatts minus ownLoad minus overhead cancels out exactly),
    // positive only when capped at limits.max leaves solar unclaimed. If the
    // hardware floor were folded in here too, a candidate that's only
    // feasible because of its bonuses would show an artificially deep
    // negative balance (having been forced up to limits.min from a genuinely
    // negative request) - which, once the bonuses are subtracted *again* for
    // the score, could let it outrank a candidate with a much lower SOC that
    // happened to be cleanly feasible without needing the floor at all.
    const maxOnlyClampedWatts = Math.min(requestWatts, limits.max);
    const balance = remainingWatts - (maxOnlyClampedWatts + ownLoad + CHARGE_CONVERSION_OVERHEAD_WATTS);
    const score = balance - totalBonus;
    // The bonus only ever decides *who* wins - the dispatched wattage is
    // still exactly what the real numbers justify (clamped up to the
    // hardware floor only now, after ranking, when urgency alone made this
    // candidate feasible).
    const clampedWatts = Math.max(limits.min, maxOnlyClampedWatts);
    scores[sn] = score;
    // Whenever nothing else is drawing and SOCs are equal, every feasible
    // candidate reaches the same score - the request just absorbs whatever's
    // left over regardless of load. Break that tie toward the lowest own
    // load: more of its charge current goes into the battery rather than
    // passing straight through, so it reaches 100% (and hands off to the
    // next candidate) sooner.
    if (!best || score < best.score || (score === best.score && ownLoad < best.ownLoad)) {
      best = { sn, requestWatts: clampedWatts, score, ownLoad };
    }
  }
  if (!best) return { watts, acOn, scores, activeSn: undefined };

  watts[best.sn] = best.requestWatts;
  acOn[best.sn] = true;
  return { watts, acOn, scores, activeSn: best.sn };
}
