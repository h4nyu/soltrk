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
  test("gives everyone min when there isn't enough solar", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, 100, LIMITS);
    assert.deepEqual(result, { [SN1]: 100, [SN2]: 100 });
  });

  test("gives everyone min when no device has room (all full or unknown)", () => {
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: undefined }, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 100, [SN2]: 100 });
  });

  test("gives the highest-priority device with room the full solar amount", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 500, [SN2]: 100 });
  });

  test("caps at max when solar exceeds it", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, 1500, LIMITS);
    assert.deepEqual(result, { [SN1]: 1200, [SN2]: 100 });
  });

  test("skips over a device with unknown SOC to the next priority device", () => {
    const result = allocate([SN1, SN2], { [SN1]: undefined, [SN2]: 50 }, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 100, [SN2]: 500 });
  });

  test("subtracts houseStandbyWatts before comparing against minToCharge and capping the target", () => {
    const limits: AllocatorLimits = { ...LIMITS, houseStandbyWatts: 400 };
    const belowThreshold = allocate([SN1], { [SN1]: 50 }, 500, limits);
    assert.deepEqual(belowThreshold, { [SN1]: 100 });

    // availableWatts=600 - houseStandbyWatts=400 -> netWatts=200.
    const aboveThreshold = allocate([SN1], { [SN1]: 50 }, 600, limits);
    assert.deepEqual(aboveThreshold, { [SN1]: 200 });
  });
});
