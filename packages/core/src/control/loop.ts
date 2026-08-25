import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { SolarSource } from "../solar/solar-source";
import { BatteryDriver, BatteryStatus } from "../battery/battery-driver";
import { Result } from "../result";
import { allocate } from "./allocator";
import { readDevices } from "./devices";

export type StateSnapshot = {
  timestamp: string;
  totalSolarWatts: number;
  // Sum of every battery's measured AC input this cycle.
  totalAcInputWatts: number;
  // Sum of every battery's measured AC output (household load passthrough)
  // this cycle.
  totalAcOutputWatts: number;
  // The balance the whole system steers toward zero: solar generation minus
  // total battery AC input. Positive = unconsumed solar (potential export),
  // negative = drawing that much from the grid on top of solar.
  balanceWatts: number;
  devices: {
    sn: string;
    name: string | undefined;
    batterySoc: number | undefined;
    acInputWatts: number | undefined;
    acOutputWatts: number | undefined;
    targetWatts: number;
    // The allocator's AC-gate decision for this device this cycle (see
    // control/allocator.ts) - what GatedBatteryDriver switches the plug to.
    acOn: boolean;
    // The allocator's ranking score for this device this cycle (lower won) -
    // undefined if it wasn't a feasible candidate at all this cycle (full,
    // unknown SOC, or infeasible even with its SOC-urgency bonus).
    score: number | undefined;
    lastCommandOk: boolean | undefined;
  }[];
};

// Port for persisting each cycle's snapshot somewhere durable - the
// composition root decides where (production: appended to a JSONL file on
// the host, see @soltrk/cli's history.ts; tests/CI: simply not provided).
// Core stays free of any logging-library dependency this way.
export type CycleRecorder = (snapshot: StateSnapshot) => void;

export type LoopDeps = {
  solar: SolarSource;
  getDriver: (vendor: string) => BatteryDriver;
  pollIntervalMs: number;
  chargeLimitMin: number;
  chargeLimitMax: number;
  minSolarToChargeWatts: number;
  houseStandbyWatts: number;
  stateFilePath: string;
  recordHistory?: CycleRecorder;
};

function writeState(stateFilePath: string, snapshot: StateSnapshot): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(snapshot, null, 2));
}

export async function runLoop(deps: LoopDeps): Promise<void> {
  const { solar, getDriver } = deps;
  await solar.connect();

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const deviceEntries = readDevices();
    const sns = deviceEntries.map((e) => e.sn);
    const nameBySn = Object.fromEntries(deviceEntries.map((e) => [e.sn, e.name]));
    const vendorBySn = Object.fromEntries(deviceEntries.map((e) => [e.sn, e.vendor ?? "anker"]));
    const totalWatts = solar.getTotalWatts();

    const statusBySn: Record<string, Result<BatteryStatus>> = {};
    for (const sn of sns) {
      statusBySn[sn] = await getDriver(vendorBySn[sn]).getStatus(sn);
    }
    const socBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, Result.isErr(s) ? undefined : s.batterySoc]),
    );
    const acInputBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, Result.isErr(s) ? undefined : s.acInputWatts]),
    );
    const acOutputBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, Result.isErr(s) ? undefined : s.acOutputWatts]),
    );

    const { watts: targets, acOn, scores } = allocate(sns, socBySn, acInputBySn, acOutputBySn, totalWatts, {
      min: deps.chargeLimitMin,
      max: deps.chargeLimitMax,
      minToCharge: deps.minSolarToChargeWatts,
      houseStandbyWatts: deps.houseStandbyWatts,
    });

    const netWatts = Math.max(0, totalWatts - deps.houseStandbyWatts);
    if (netWatts >= deps.minSolarToChargeWatts && Object.values(acOn).every((on) => !on)) {
      console.warn(`[loop] ${totalWatts.toFixed(1)}W solar available but every Anker unit is full or unreachable`);
    }

    const deviceStates: StateSnapshot["devices"] = [];
    for (const sn of sns) {
      const target = targets[sn];
      // Sent every cycle, even when target is unchanged from last time: a
      // gated device's actual on/off decision (see GatedBatteryDriver) can
      // depend on live SOC even when the requested wattage itself doesn't
      // change, so skipping unchanged-looking calls would make that check
      // silently stop running.
      const commandResult = await getDriver(vendorBySn[sn]).setChargeLimit(sn, target, acOn[sn]);
      const status = statusBySn[sn];
      deviceStates.push({
        sn,
        name: nameBySn[sn],
        batterySoc: Result.isErr(status) ? undefined : status.batterySoc,
        acInputWatts: Result.isErr(status) ? undefined : status.acInputWatts,
        acOutputWatts: Result.isErr(status) ? undefined : status.acOutputWatts,
        targetWatts: target,
        acOn: acOn[sn],
        score: scores[sn],
        lastCommandOk: Result.isOk(commandResult),
      });
    }

    const totalAcInputWatts = deviceStates.reduce((sum, d) => sum + (d.acInputWatts ?? 0), 0);
    const totalAcOutputWatts = deviceStates.reduce((sum, d) => sum + (d.acOutputWatts ?? 0), 0);
    const balanceWatts = totalWatts - totalAcInputWatts;

    const snapshot: StateSnapshot = {
      timestamp: new Date().toISOString(),
      totalSolarWatts: totalWatts,
      totalAcInputWatts,
      totalAcOutputWatts,
      balanceWatts,
      devices: deviceStates,
    };
    writeState(deps.stateFilePath, snapshot);
    deps.recordHistory?.(snapshot);

    const r1 = (n: number) => n.toFixed(1);
    console.log(
      `[loop] solar=${r1(totalWatts)}W input=${r1(totalAcInputWatts)}W output=${r1(totalAcOutputWatts)}W ` +
        `balance=${balanceWatts >= 0 ? "+" : ""}${r1(balanceWatts)}W ` +
        deviceStates
          .map(
            (d) =>
              `${d.name ?? d.sn}:${d.acOn ? "ON" : "OFF"},soc=${d.batterySoc ?? "?"}%,` +
              `in=${d.acInputWatts === undefined ? "?" : r1(d.acInputWatts)}W,` +
              `out=${d.acOutputWatts === undefined ? "?" : r1(d.acOutputWatts)}W,` +
              `target=${r1(d.targetWatts)}W,score=${d.score === undefined ? "-" : r1(d.score)}`,
          )
          .join(" "),
    );

    await new Promise((r) => setTimeout(r, deps.pollIntervalMs));
  }

  solar.disconnect();
}
