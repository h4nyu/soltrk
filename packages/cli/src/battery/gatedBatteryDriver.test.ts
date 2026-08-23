import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BatteryDriver, BatteryStatus } from "@soltrk/core";
import { GatedBatteryDriver, PowerGate } from "./gatedBatteryDriver";

const GATED_SN = "gated-sn";
const OTHER_SN = "other-sn";
const OFF_WATTS = 100;
const CRITICAL_SOC_PERCENT = 6;

function fakeInner(batterySoc?: number): BatteryDriver & { calls: { sn: string; watts: number }[] } {
  return {
    calls: [],
    async getStatus(): Promise<BatteryStatus | undefined> {
      return batterySoc === undefined ? undefined : { batterySoc };
    },
    async setChargeLimit(sn: string, watts: number): Promise<boolean> {
      this.calls.push({ sn, watts });
      return true;
    },
  };
}

function fakeGate(): PowerGate & { calls: boolean[] } {
  return {
    calls: [],
    async setOn(on: boolean): Promise<boolean> {
      this.calls.push(on);
      return true;
    },
  };
}

describe("GatedBatteryDriver", () => {
  test("passes through unchanged for an sn with no configured plug", async () => {
    const inner = fakeInner();
    const driver = new GatedBatteryDriver(inner, new Map(), OFF_WATTS, CRITICAL_SOC_PERCENT);

    const ok = await driver.setChargeLimit(OTHER_SN, 500);

    assert.equal(ok, true);
    assert.deepEqual(inner.calls, [{ sn: OTHER_SN, watts: 500 }]);
  });

  test("cuts the plug and skips the wattage command at/below offWatts", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();
    const driver = new GatedBatteryDriver(inner, new Map([[GATED_SN, gate]]), OFF_WATTS, CRITICAL_SOC_PERCENT);

    const ok = await driver.setChargeLimit(GATED_SN, OFF_WATTS);

    assert.equal(ok, true);
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("opens the plug then still sends the wattage command above offWatts", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();
    const driver = new GatedBatteryDriver(inner, new Map([[GATED_SN, gate]]), OFF_WATTS, CRITICAL_SOC_PERCENT);

    const ok = await driver.setChargeLimit(GATED_SN, 300);

    assert.equal(ok, true);
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: 300 }]);
  });

  test("fails without touching the inner driver when the plug command fails", async () => {
    const inner = fakeInner(50);
    const gate: PowerGate = { setOn: async () => false };
    const driver = new GatedBatteryDriver(inner, new Map([[GATED_SN, gate]]), OFF_WATTS, CRITICAL_SOC_PERCENT);

    const ok = await driver.setChargeLimit(GATED_SN, 300);

    assert.equal(ok, false);
    assert.deepEqual(inner.calls, []);
  });

  test("forces the gate on and charges at the requested (minimum) wattage when SOC is at the critical floor", async () => {
    const inner = fakeInner(CRITICAL_SOC_PERCENT);
    const gate = fakeGate();
    const driver = new GatedBatteryDriver(inner, new Map([[GATED_SN, gate]]), OFF_WATTS, CRITICAL_SOC_PERCENT);

    const ok = await driver.setChargeLimit(GATED_SN, OFF_WATTS);

    assert.equal(ok, true);
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: OFF_WATTS }]);
  });

  test("does not force the gate on above the critical SOC floor", async () => {
    const inner = fakeInner(CRITICAL_SOC_PERCENT + 1);
    const gate = fakeGate();
    const driver = new GatedBatteryDriver(inner, new Map([[GATED_SN, gate]]), OFF_WATTS, CRITICAL_SOC_PERCENT);

    const ok = await driver.setChargeLimit(GATED_SN, OFF_WATTS);

    assert.equal(ok, true);
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("does not force the gate on when SOC is unknown", async () => {
    const inner = fakeInner(undefined);
    const gate = fakeGate();
    const driver = new GatedBatteryDriver(inner, new Map([[GATED_SN, gate]]), OFF_WATTS, CRITICAL_SOC_PERCENT);

    const ok = await driver.setChargeLimit(GATED_SN, OFF_WATTS);

    assert.equal(ok, true);
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });
});
