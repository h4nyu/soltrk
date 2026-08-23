import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BatteryDriver, BatteryStatus, Result } from "@soltrk/core";
import { GatedBatteryDriver, PowerGate } from "./gated-battery-driver";

const GATED_SN = "gated-sn";
const OTHER_SN = "other-sn";
const OFF_WATTS = 100;
const CRITICAL_SOC_PERCENT = 6;
const RECOVERY_SOC_PERCENT = 20;

function fakeInner(batterySoc?: number): BatteryDriver & { calls: { sn: string; watts: number }[] } {
  return {
    calls: [],
    async getStatus(): Promise<Result<BatteryStatus>> {
      return batterySoc === undefined ? new Error("no status") : { batterySoc };
    },
    async setChargeLimit(sn: string, watts: number): Promise<Result<void>> {
      this.calls.push({ sn, watts });
      return undefined;
    },
  };
}

// Like fakeInner, but the SOC can be changed between calls - for tests that
// simulate several poll cycles in a row with the battery's charge moving.
function fakeInnerWithMutableSoc(): BatteryDriver & { soc: number | undefined } {
  const state = {
    soc: undefined as number | undefined,
    async getStatus(): Promise<Result<BatteryStatus>> {
      return state.soc === undefined ? new Error("no status") : { batterySoc: state.soc };
    },
    async setChargeLimit(): Promise<Result<void>> {
      return undefined;
    },
  };
  return state;
}

function fakeGate(): PowerGate & { calls: boolean[] } {
  return {
    calls: [],
    async setOn(on: boolean): Promise<Result<void>> {
      this.calls.push(on);
      return undefined;
    },
  };
}

function driver(
  inner: BatteryDriver,
  plugsBySn: Map<string, PowerGate>,
): BatteryDriver {
  return GatedBatteryDriver({
    inner,
    plugsBySn,
    offWatts: OFF_WATTS,
    criticalSocPercent: CRITICAL_SOC_PERCENT,
    recoverySocPercent: RECOVERY_SOC_PERCENT,
  });
}

describe("GatedBatteryDriver", () => {
  test("passes through unchanged for an sn with no configured plug", async () => {
    const inner = fakeInner();

    const result = await driver(inner, new Map()).setChargeLimit(OTHER_SN, 500);

    assert.ok(!(result instanceof Error));
    assert.deepEqual(inner.calls, [{ sn: OTHER_SN, watts: 500 }]);
  });

  test("follows an explicit acOn=true even at idle wattage (full-battery passthrough)", async () => {
    const inner = fakeInner(100);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS, true);

    assert.ok(!(result instanceof Error));
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: OFF_WATTS }]);
  });

  test("follows an explicit acOn=false even at a high wattage", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, 500, false);

    assert.ok(!(result instanceof Error));
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("cuts the plug and skips the wattage command at/below offWatts", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS);

    assert.ok(!(result instanceof Error));
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("opens the plug then still sends the wattage command above offWatts", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, 300);

    assert.ok(!(result instanceof Error));
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: 300 }]);
  });

  test("fails without touching the inner driver when the plug command fails", async () => {
    const inner = fakeInner(50);
    const gate: PowerGate = { setOn: async () => new Error("plug unreachable") };

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, 300);

    assert.ok(result instanceof Error);
    assert.deepEqual(inner.calls, []);
  });

  test("forces the gate on and charges at the requested (minimum) wattage when SOC is at the critical floor", async () => {
    const inner = fakeInner(CRITICAL_SOC_PERCENT);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS);

    assert.ok(!(result instanceof Error));
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: OFF_WATTS }]);
  });

  test("does not force the gate on above the critical SOC floor", async () => {
    const inner = fakeInner(CRITICAL_SOC_PERCENT + 1);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS);

    assert.ok(!(result instanceof Error));
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("does not force the gate on when SOC is unknown", async () => {
    const inner = fakeInner(undefined);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS);

    assert.ok(!(result instanceof Error));
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("stays forced on between the critical and recovery thresholds (hysteresis), then releases at recovery", async () => {
    const inner = fakeInnerWithMutableSoc();
    const gate = fakeGate();
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    inner.soc = CRITICAL_SOC_PERCENT; // dips to the floor: forces on
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = CRITICAL_SOC_PERCENT + 5; // recovering, but still below recovery threshold
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = RECOVERY_SOC_PERCENT - 1; // just under recovery: still forced
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = RECOVERY_SOC_PERCENT; // reaches recovery: released, back to normal (off at offWatts)
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    assert.deepEqual(gate.calls, [true, true, true, false]);
  });

  test("keeps the last forced decision when SOC is unreadable mid-recovery", async () => {
    const inner = fakeInnerWithMutableSoc();
    const gate = fakeGate();
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    inner.soc = CRITICAL_SOC_PERCENT; // forces on
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = undefined; // status read fails this cycle
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    assert.deepEqual(gate.calls, [true, true]);
  });
});
