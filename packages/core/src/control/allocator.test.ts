import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allocate, AllocatorLimits } from "./allocator";

const SN1 = "sn-1";
const SN2 = "sn-2";
const LIMITS: AllocatorLimits = {
  min: 100,
  max: 1200,
  minToCharge: 150,
  houseStandbyWatts: 0,
};

describe("allocate", () => {
  test("disconnects everyone at min when there isn't enough solar", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, {}, 100, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 100 });
    assert.deepEqual(result.acOn, { [SN1]: false, [SN2]: false });
  });

  test("gives the highest-priority device with room the full solar amount", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, {}, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 500, [SN2]: 100 });
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: false });
  });

  test("caps at max when solar exceeds it", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, {}, 1500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 1200, [SN2]: 100 });
  });

  test("subtracts other devices' measured input from the active target", () => {
    // SN2 is force-charging (critical rescue) at a measured 130W - solar
    // 500W leaves only 370W for the active SN1.
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 10 }, { [SN2]: 130 }, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 370, [SN2]: 100 });
  });

  test("floors the active target at min when others already consume all the solar", () => {
    // Two force-charging peers at 130W each already exceed 200W of solar -
    // raising the active device's request above min would only widen grid
    // draw.
    const result = allocate(
      [SN1, SN2, "sn-3"],
      { [SN1]: 10, [SN2]: 10, "sn-3": 10 },
      { [SN2]: 130, "sn-3": 130 },
      200,
      LIMITS,
    );
    assert.equal(result.watts[SN1], 100);
  });

  test("keeps a full device connected for passthrough while solar is sufficient", () => {
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 50 }, {}, 500, LIMITS);
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: true });
    // The full device idles at min; the active one gets the solar (minus
    // whatever the full one is measured to pass through - none here).
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 500 });
  });

  test("a full device's passthrough consumption reduces the active target", () => {
    // Full SN1 passes ~90W of solar through to its load - active SN2 gets
    // solar minus that.
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 50 }, { [SN1]: 90 }, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 410 });
  });

  test("disconnects a full device once solar drops below the threshold", () => {
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 50 }, {}, 100, LIMITS);
    assert.deepEqual(result.acOn, { [SN1]: false, [SN2]: false });
  });

  test("everyone full: passthrough stays on, nothing charges", () => {
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 100 }, {}, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 100 });
    assert.deepEqual(result.acOn, { [SN1]: true, [SN2]: true });
  });

  test("skips over a device with unknown SOC to the next priority device", () => {
    const result = allocate([SN1, SN2], { [SN1]: undefined, [SN2]: 50 }, {}, 500, LIMITS);
    assert.deepEqual(result.watts, { [SN1]: 100, [SN2]: 500 });
    assert.deepEqual(result.acOn, { [SN1]: false, [SN2]: true });
  });

  test("subtracts houseStandbyWatts before comparing against minToCharge and capping the target", () => {
    const limits: AllocatorLimits = { ...LIMITS, houseStandbyWatts: 400 };
    const belowThreshold = allocate([SN1], { [SN1]: 50 }, {}, 500, limits);
    assert.deepEqual(belowThreshold.watts, { [SN1]: 100 });
    assert.deepEqual(belowThreshold.acOn, { [SN1]: false });

    // availableWatts=600 - houseStandbyWatts=400 -> netWatts=200.
    const aboveThreshold = allocate([SN1], { [SN1]: 50 }, {}, 600, limits);
    assert.deepEqual(aboveThreshold.watts, { [SN1]: 200 });
  });
});
