import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AcMode, BatteryDriver, BatteryStatus, Result } from "@soltrk/core";
import { GatedBatteryDriver, PowerGate } from "./gated-battery-driver";

const GATED_SN = "gated-sn";
const OTHER_SN = "other-sn";
const OFF_WATTS = 100;
const DISCHARGE_FLOOR_SOC_PERCENT = 6;

type InnerCall = { sn: string; watts: number; mode: AcMode | undefined };

function fakeInner(batterySoc?: number): BatteryDriver & { calls: InnerCall[] } {
  return {
    calls: [],
    async getStatus(): Promise<Result<BatteryStatus>> {
      return batterySoc === undefined ? new Error("no status") : { batterySoc };
    },
    async setChargeLimit(sn: string, watts: number, mode?: AcMode): Promise<Result<AcMode>> {
      this.calls.push({ sn, watts, mode });
      return mode ?? "charge";
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
    async setChargeLimit(): Promise<Result<AcMode>> {
      return "charge";
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
    dischargeFloorSocPercent: DISCHARGE_FLOOR_SOC_PERCENT,
  });
}

describe("GatedBatteryDriver", () => {
  test("passes through unchanged for an sn with no configured plug", async () => {
    const inner = fakeInner();

    const result = await driver(inner, new Map()).setChargeLimit(OTHER_SN, 500, "charge");

    assert.ok(Result.isOk(result));
    assert.deepEqual(inner.calls, [{ sn: OTHER_SN, watts: 500, mode: "charge" }]);
  });

  test("closes the plug for passthrough even at idle wattage, and forwards the mode", async () => {
    const inner = fakeInner(100);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(
      GATED_SN,
      OFF_WATTS,
      "passthrough",
    );

    assert.ok(Result.isOk(result));
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: OFF_WATTS, mode: "passthrough" }]);
  });

  test("follows an explicit battery mode even at a high wattage", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(
      GATED_SN,
      500,
      "battery",
    );

    assert.ok(Result.isOk(result));
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("cuts the plug and skips the wattage command at/below offWatts", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS);

    assert.ok(Result.isOk(result));
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("opens the plug then still sends the wattage command above offWatts", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, 300);

    assert.ok(Result.isOk(result));
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: 300, mode: "charge" }]);
  });

  test("fails without touching the inner driver when the plug command fails", async () => {
    const inner = fakeInner(50);
    const gate: PowerGate = { setOn: async () => new Error("plug unreachable") };

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, 300);

    assert.ok(Result.isErr(result));
    assert.deepEqual(inner.calls, []);
  });

  test("below the floor, stops the battery running the load and passes AC through instead", async () => {
    // The floor exists to stop the battery draining, which passthrough does
    // by feeding the device's own load from AC - without buying grid power
    // to push into the battery, or paying the conversion overhead to do it.
    const inner = fakeInner(DISCHARGE_FLOOR_SOC_PERCENT);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(
      GATED_SN,
      OFF_WATTS,
      "battery",
    );

    assert.ok(Result.isOk(result));
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: OFF_WATTS, mode: "passthrough" }]);
    // Reported back so the caller logs/records what actually happened,
    // rather than the "battery" it asked for.
    assert.equal(result, "passthrough");
  });

  test("reports back the mode that was applied, floor or no floor", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    assert.equal(await d.setChargeLimit(GATED_SN, 300, "charge"), "charge");
    assert.equal(await d.setChargeLimit(GATED_SN, OFF_WATTS, "passthrough"), "passthrough");
    assert.equal(await d.setChargeLimit(GATED_SN, OFF_WATTS, "battery"), "battery");
  });

  test("the floor never downgrades a device the allocator already chose to charge", async () => {
    // Charging is strictly better than passthrough for a nearly empty
    // battery - it refills rather than merely holding - so being below the
    // floor must not take that away.
    const inner = fakeInner(DISCHARGE_FLOOR_SOC_PERCENT);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(
      GATED_SN,
      400,
      "charge",
    );

    assert.ok(Result.isOk(result));
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: 400, mode: "charge" }]);
  });

  test("leaves a device on its battery above the discharge floor", async () => {
    const inner = fakeInner(DISCHARGE_FLOOR_SOC_PERCENT + 1);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS);

    assert.ok(Result.isOk(result));
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("holds a device on AC when SOC is unknown", async () => {
    // An SOC that can't be read is treated as below the floor. Being wrong
    // that way costs a cycle of passthrough; being wrong the other way keeps
    // draining a battery with the cutoff open and no reading to stop it.
    const inner = fakeInner(undefined);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS);

    assert.equal(result, "passthrough");
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: OFF_WATTS, mode: "passthrough" }]);
  });

  test("still charges a device whose SOC is unknown when the allocator picks it", async () => {
    // The unreadable-SOC rule takes `battery` off the table, exactly like the
    // floor itself does - it doesn't block the one mode that refills.
    const inner = fakeInner(undefined);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, 400, "charge");

    assert.equal(result, "charge");
    assert.deepEqual(gate.calls, [true]);
    assert.deepEqual(inner.calls, [{ sn: GATED_SN, watts: 400, mode: "charge" }]);
  });

  test("goes back to its battery as soon as it's charged above the floor again", async () => {
    // The floor is evaluated fresh from the current SOC every cycle - there's
    // no second, higher threshold to climb to first, and no memory of having
    // been below it.
    const inner = fakeInnerWithMutableSoc();
    const gate = fakeGate();
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    inner.soc = DISCHARGE_FLOOR_SOC_PERCENT; // dips to the floor: plug closes
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = DISCHARGE_FLOOR_SOC_PERCENT + 1; // one point above: plug opens again
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    assert.deepEqual(gate.calls, [true, false]);
  });

  test("does not release a device back to its battery when SOC stops reading", async () => {
    // The case that prompted this: after a restart the first cycle has no
    // status yet, and the old behaviour handed all three units straight back
    // to their batteries at 6-10% SOC.
    const inner = fakeInnerWithMutableSoc();
    const gate = fakeGate();
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    inner.soc = DISCHARGE_FLOOR_SOC_PERCENT; // plug closes
    await d.setChargeLimit(GATED_SN, OFF_WATTS, "battery");

    inner.soc = undefined; // status read fails this cycle
    await d.setChargeLimit(GATED_SN, OFF_WATTS, "battery");

    // Still closed, and the plug wasn't needlessly re-commanded.
    assert.deepEqual(gate.calls, [true]);
  });

  test("does not re-invoke the plug when the gate state hasn't changed since last time", async () => {
    const inner = fakeInner(50);
    const gate = fakeGate();
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    await d.setChargeLimit(GATED_SN, 300); // gate on
    await d.setChargeLimit(GATED_SN, 350); // still on, different wattage

    assert.deepEqual(gate.calls, [true]);
    // The wattage command itself still goes out every cycle the gate is on.
    assert.deepEqual(inner.calls, [
      { sn: GATED_SN, watts: 300, mode: "charge" },
      { sn: GATED_SN, watts: 350, mode: "charge" },
    ]);
  });

  test("retries the plug on the next cycle after a failed attempt, even though the state didn't change", async () => {
    const inner = fakeInner(50);
    let calls = 0;
    const gate: PowerGate = {
      setOn: async (on) => {
        calls++;
        return calls === 1 ? new Error("plug unreachable") : undefined;
      },
    };
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    const first = await d.setChargeLimit(GATED_SN, 300);
    const second = await d.setChargeLimit(GATED_SN, 300);

    assert.ok(Result.isErr(first));
    assert.ok(Result.isOk(second));
    assert.equal(calls, 2);
  });
});
