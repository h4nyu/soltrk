import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allocate, AllocatorLimits } from "./allocator";

const SN1 = "sn-1";
const SN2 = "sn-2";
// min + the 33W conversion overhead is the derived charge threshold these
// tests sit either side of: 133W.
const LIMITS: AllocatorLimits = {
  min: 100,
  max: 1200,
  houseStandbyWatts: 0,
};

describe("allocate", () => {
  test("charges nobody when there isn't enough solar", () => {
    // Both still get AC - there's solar, and they draw nothing beyond a load
    // they don't currently have - but neither is picked to charge.
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, {}, {}, 100, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 100 });
    assert.equal(result.activeSn, undefined);
  });

  test("disconnects everyone once solar is gone entirely", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, {}, {}, 0, LIMITS);
    assert.deepEqual(result.acOn, { [SN1]: false, [SN2]: false });
  });

  test("gives the only candidate the solar amount, net of conversion overhead", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 100 }, {}, {}, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 467, [SN2]: 100 });
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: true });
  });

  test("caps at max when solar exceeds it", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 100 }, {}, {}, 1500, LIMITS);
    assert.equal(result.watts[SN1], 1200);
  });

  test("subtracts other devices' measured input from a candidate's target", () => {
    // SN2 is drawing a measured 130W - solar
    // 500W leaves 370W for SN1, minus 33W conversion overhead. Both at the
    // same SOC so the SOC-urgency bonus cancels out and doesn't confound
    // this input-subtraction behavior with the tie-break it'd otherwise win
    // on for having a lower SOC (see the "urgency" tests below for that).
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, { [SN2]: 130 }, {}, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 337, [SN2]: 100 });
  });

  test("a low enough SOC wins even when others already consume all the solar", () => {
    // Two force-charging peers at 130W each already exceed 200W of solar,
    // leaving nothing for SN1 under the raw math - but SN1 is just as low
    // on SOC as they are, so its urgency bonus makes it feasible anyway
    // rather than making it wait for its own discharge floor to trip.
    const result = allocate(
      [SN1, SN2, "sn-3"],
      { [SN1]: 10, [SN2]: 10, "sn-3": 10 },
      { [SN2]: 130, "sn-3": 130 },
      {},
      200,
      LIMITS,
    );
    assert.equal(result.watts[SN1], 100);
    assert.equal(result.acOn[SN1], true);
  });

  test("a low-SOC candidate outranks a well-charged incumbent already drawing most of the solar", () => {
    // SN2 (90% SOC) is already drawing 400W of the 450W available and would
    // otherwise cleanly win (its own request perfectly absorbs the
    // remaining 50W, a textbook zero balance). SN1 (10% SOC, and its own
    // 100W household load) looks deeply infeasible under the raw math
    // (50 - 100 - 33 = -83W) - but its urgency bonus flips the ranking, so
    // it wins and gets switched on at the hardware minimum instead of
    // waiting for SN2 to finish or for its own discharge floor to trip.
    const result = allocate([SN1, SN2], { [SN1]: 10, [SN2]: 90 }, { [SN2]: 400 }, { [SN1]: 100 }, 450, LIMITS);
    assert.equal(result.activeSn, SN1);
    assert.equal(result.watts[SN1], 100);
  });

  test("a candidate only feasible because of its own urgency bonus can't outrank a genuinely lower-SOC one", () => {
    // SN1 (10% SOC) is cleanly feasible on its own (467W, well inside
    // limits.max) with nothing else drawing - balance 0, so its score is
    // driven entirely by its own (large) urgency bonus. SN2 (50% SOC) is
    // only feasible at all because SN1 is already measured drawing 467W,
    // pushing SN2's raw request to -50W - its own (smaller) urgency bonus
    // just barely clears the floor. If the hardware-minimum clamp leaked
    // into SN2's balance, that forced-up deficit plus its own bonus could
    // (bug, since fixed) outscore SN1 despite SN1 having a much lower SOC.
    const result = allocate(
      [SN1, SN2],
      { [SN1]: 10, [SN2]: 50 },
      { [SN1]: 467 },
      { [SN2]: 50 },
      500,
      LIMITS,
    );
    assert.equal(result.activeSn, SN1);
    // SN2 still gets AC - solar can cover its 50W load, so there's no
    // reason to make it run that off its battery - it just doesn't charge.
    assert.equal(result.acOn[SN2], true);
  });

  test("a sticky incumbent keeps winning against a marginally-better challenger", () => {
    // SN2 is only 1 point of SOC lower than incumbent SN1 - without the
    // sticky bonus SN2's slightly larger urgency bonus would win outright,
    // flipping the active device on a difference this small.
    const result = allocate([SN1, SN2], { [SN1]: 41, [SN2]: 42 }, {}, {}, 500, LIMITS, SN1);
    assert.equal(result.activeSn, SN1);
  });

  test("a clearly better challenger still takes over from the sticky incumbent", () => {
    // SN2 is 80 points of SOC lower than incumbent SN1 - its urgency bonus
    // (240W) easily clears SN1's combined urgency + sticky bonus (60W), so
    // the sticky bonus doesn't just freeze the winner forever.
    const result = allocate([SN1, SN2], { [SN1]: 90, [SN2]: 10 }, {}, {}, 500, LIMITS, SN1);
    assert.equal(result.activeSn, SN2);
  });

  test("prefers whichever candidate has the least load of its own", () => {
    // Both SN1 and SN2 could take the full 500W of solar, but SN2 is
    // already feeding a 200W load of its own - switching SN1 on instead
    // makes fuller use of the available solar (nothing left over besides
    // conversion overhead) than switching SN2 on would (200W would still
    // go unclaimed).
    const result = allocate(
      [SN1, SN2],
      { [SN1]: 50, [SN2]: 50 },
      {},
      { [SN1]: 0, [SN2]: 200 },
      500,
      LIMITS,
    );
    assert.equal(result.activeSn, SN1);
    assert.equal(result.watts[SN1], 467);
    // SN2's 200W load is covered by solar rather than by its own battery,
    // even though it lost the charging slot.
    assert.equal(result.acOn[SN2], true);
  });

  test("covers a losing candidate's load from solar instead of its battery", () => {
    // SN2 loses the charging slot but has a 120W load of its own. Solar can
    // cover it, so it stays on AC rather than running that load down its
    // battery only to have to put the energy back later.
    const result = allocate(
      [SN1, SN2],
      { [SN1]: 20, [SN2]: 80 },
      {},
      { [SN1]: 0, [SN2]: 120 },
      500,
      LIMITS,
    );
    assert.equal(result.activeSn, SN1);
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: true });
  });

  test("imports the shortfall rather than charging while a unit discharges", () => {
    // 500W of solar against a 300W and a 250W load. Covering both means
    // importing 50W; the alternative is covering only SN2 and charging with
    // the leftover 200W while SN1 runs its 250W load off its own battery -
    // paying a charge overhead and a discharge loss to move energy that
    // could have flowed straight in. So both get covered and nothing
    // charges.
    const result = allocate(
      [SN1, SN2],
      { [SN1]: 60, [SN2]: 30 },
      {},
      { [SN1]: 250, [SN2]: 300 },
      500,
      LIMITS,
    );
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: true });
    assert.equal(result.activeSn, undefined);
  });

  test("leaves a load on its battery when the leftover couldn't have charged anyway", () => {
    // 150W of solar against a 300W load, and only 20W left after the 130W
    // that SN2's load takes. There's no charge for that 20W to displace, so
    // importing 280W to cover SN1 would buy nothing - SN1 stays on its
    // battery, which is what the battery is for.
    const result = allocate(
      [SN1, SN2],
      { [SN1]: 60, [SN2]: 30 },
      {},
      { [SN1]: 300, [SN2]: 130 },
      150,
      LIMITS,
    );
    assert.equal(result.acOn[SN2], true);
    assert.equal(result.acOn[SN1], false);
  });

  test("covers the emptiest battery's load first when solar can't cover both", () => {
    // 200W of solar, two 150W loads - only one fits. SN2 is the more
    // depleted of the two, so it's the one that stops discharging.
    const result = allocate(
      [SN1, SN2],
      { [SN1]: 70, [SN2]: 15 },
      {},
      { [SN1]: 150, [SN2]: 150 },
      200,
      LIMITS,
    );
    assert.equal(result.acOn[SN2], true);
    assert.equal(result.acOn[SN1], false);
  });

  test("connects a device measuring no load at all", () => {
    // Its load is only zero until someone switches something on, and it
    // costs nothing to have it already on AC when that happens - a
    // disconnected unit would discharge until the next poll noticed.
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, {}, {}, 500, LIMITS);
    assert.equal(result.activeSn, SN1);
    assert.equal(result.acOn[SN2], true);
  });

  test("keeps a full device connected for passthrough while solar is sufficient", () => {
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 50 }, {}, {}, 500, LIMITS);
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: true });
    // The full device idles at min; the candidate gets the solar (minus
    // whatever the full one is measured to pass through - none here - and
    // minus conversion overhead).
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 467 });
  });

  test("a full device's passthrough consumption reduces a candidate's target", () => {
    // Full SN1 passes ~90W of solar through to its load - candidate SN2
    // gets solar minus that, minus conversion overhead.
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 50 }, { [SN1]: 90 }, {}, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 377 });
  });

  test("passes through below the charging threshold without charging anyone", () => {
    // 100W of solar is below the 133W charge threshold - too little to be worth
    // starting a charge, but both still pass it through to their own loads
    // rather than draining their batteries for no reason.
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 50 }, {}, {}, 100, LIMITS);
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: true });
    assert.equal(result.activeSn, undefined);
  });

  test("disconnects a full device once solar is entirely gone", () => {
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 50 }, {}, {}, 0, LIMITS);
    assert.deepEqual(result.acOn, { [SN1]: false, [SN2]: false });
  });

  test("everyone full: passthrough stays on, nothing charges", () => {
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 100 }, {}, {}, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 100 });
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: true });
  });

  test("skips over a device with unknown SOC", () => {
    const result = allocate([SN1, SN2], { [SN1]: undefined, [SN2]: 50 }, {}, {}, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 467 });
    assert.deepEqual(result.acOn, { [SN1]: false, [SN2]: true });
  });

  test("subtracts houseStandbyWatts before comparing against minToCharge and capping the target", () => {
    const limits: AllocatorLimits = { ...LIMITS, houseStandbyWatts: 400 };
    const belowThreshold = allocate([SN1], { [SN1]: 50 }, {}, {}, 500, limits);
    assert.deepEqual(belowThreshold.watts, { [SN1]: 100 });
    assert.equal(belowThreshold.activeSn, undefined);

    // availableWatts=600 - houseStandbyWatts=400 -> netWatts=200, minus 33W
    // conversion overhead.
    const aboveThreshold = allocate([SN1], { [SN1]: 50 }, {}, {}, 600, limits);
    assert.deepEqual(aboveThreshold.watts, { [SN1]: 167 });
  });
});
