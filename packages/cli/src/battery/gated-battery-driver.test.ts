import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AcMode, BatteryDriver, BatteryStatus, Result } from "@soltrk/core";
import { GatedBatteryDriver, PowerGate } from "./gated-battery-driver";

const GATED_SN = "gated-sn";
const OTHER_SN = "other-sn";
const OFF_WATTS = 100;
const DISCHARGE_FLOOR_SOC_PERCENT = 6;
const DISCHARGE_RESUME_SOC_PERCENT = 20;

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
    dischargeResumeSocPercent: DISCHARGE_RESUME_SOC_PERCENT,
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

  test("leaves a device on its battery when SOC is unknown", async () => {
    const inner = fakeInner(undefined);
    const gate = fakeGate();

    const result = await driver(inner, new Map([[GATED_SN, gate]])).setChargeLimit(GATED_SN, OFF_WATTS);

    assert.ok(Result.isOk(result));
    assert.deepEqual(gate.calls, [false]);
    assert.deepEqual(inner.calls, []);
  });

  test("stays on AC between the floor and the resume threshold, then discharges again at resume", async () => {
    const inner = fakeInnerWithMutableSoc();
    const gate = fakeGate();
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    inner.soc = DISCHARGE_FLOOR_SOC_PERCENT; // dips to the floor: plug closes
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = DISCHARGE_FLOOR_SOC_PERCENT + 5; // charging back up, but not yet allowed to discharge
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = DISCHARGE_RESUME_SOC_PERCENT - 1; // just under resume: still on AC
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = DISCHARGE_RESUME_SOC_PERCENT; // reaches resume: free to run on its battery again
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    // The plug itself is only re-commanded on an actual transition (see
    // "does not re-invoke the plug..." below) - it stays closed for the
    // middle two cycles, so those don't show up here.
    assert.deepEqual(gate.calls, [true, false]);
  });

  test("keeps whichever side of the floor it was on when SOC is unreadable", async () => {
    const inner = fakeInnerWithMutableSoc();
    const gate = fakeGate();
    const d = driver(inner, new Map([[GATED_SN, gate]]));

    inner.soc = DISCHARGE_FLOOR_SOC_PERCENT; // plug closes
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    inner.soc = undefined; // status read fails this cycle
    await d.setChargeLimit(GATED_SN, OFF_WATTS);

    // Still below the floor both cycles, so the plug is only commanded once.
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
