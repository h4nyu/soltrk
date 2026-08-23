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
  rampStepWatts: 200,
};

describe("allocate", () => {
  test("gives everyone min when there isn't enough solar", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, {}, 100, LIMITS);
    assert.deepEqual(result, { [SN1]: 100, [SN2]: 100 });
  });

  test("gives everyone min when no device has room (all full or unknown)", () => {
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: undefined }, {}, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 100, [SN2]: 100 });
  });

  test("ramps the highest-priority device with room up from its current input by rampStepWatts", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, { [SN1]: 0 }, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 200, [SN2]: 100 });
  });

  test("uses limits.min as the ramp base when current input is unknown", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, {}, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 300, [SN2]: 100 });
  });

  test("ramps from the real measured input, not a remembered request", () => {
    // Even if we'd asked for 300W last cycle, the device only actually drew 250W.
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, { [SN1]: 250 }, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 450, [SN2]: 100 });
  });

  test("caps the ramp at max when solar exceeds it", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, { [SN1]: 1100 }, 1500, LIMITS);
    assert.deepEqual(result, { [SN1]: 1200, [SN2]: 100 });
  });

  test("caps the ramp at current solar, not just at max, when solar is well below max", () => {
    // Without a solar cap, ramping would keep climbing every cycle toward
    // 1200W regardless of solar - here solar is only 300W, so once the ramp
    // reaches it the request should hold there, not keep climbing.
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, { [SN1]: 250 }, 300, LIMITS);
    assert.deepEqual(result, { [SN1]: 300, [SN2]: 100 });
  });

  test("resets to min instantly (no ramp) once solar drops, even if it was drawing a lot before", () => {
    const result = allocate([SN1, SN2], { [SN1]: 50, [SN2]: 50 }, { [SN1]: 900 }, 0, LIMITS);
    assert.deepEqual(result, { [SN1]: 100, [SN2]: 100 });
  });

  test("a newly-active device (e.g. the previous one just finished) ramps from its own current input", () => {
    // SN1 finished charging (now full); SN2 becomes active, currently drawing nothing.
    const result = allocate([SN1, SN2], { [SN1]: 100, [SN2]: 50 }, { [SN1]: 900, [SN2]: 0 }, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 100, [SN2]: 200 });
  });

  test("skips over a device with unknown SOC to the next priority device", () => {
    const result = allocate([SN1, SN2], { [SN1]: undefined, [SN2]: 50 }, {}, 500, LIMITS);
    assert.deepEqual(result, { [SN1]: 100, [SN2]: 300 });
  });

  test("subtracts houseStandbyWatts before comparing against minToCharge and capping the ramp", () => {
    const limits: AllocatorLimits = { ...LIMITS, houseStandbyWatts: 400 };
    const belowThreshold = allocate([SN1], { [SN1]: 50 }, {}, 500, limits);
    assert.deepEqual(belowThreshold, { [SN1]: 100 });

    // availableWatts=600 - houseStandbyWatts=400 -> netWatts=200, which also
    // caps the ramp (100 + 200 rampStep = 300, but capped down to 200).
    const aboveThreshold = allocate([SN1], { [SN1]: 50 }, {}, 600, limits);
    assert.deepEqual(aboveThreshold, { [SN1]: 200 });
  });
});
