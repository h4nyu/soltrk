import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { SolarSource } from "../solar/SolarSource";
import { BatteryDriver, BatteryStatus } from "../battery/BatteryDriver";
import { Result } from "../result";
import { allocate } from "./allocator";
import { PriorityEntry, readPriority } from "./priority";

export type StateSnapshot = {
  timestamp: string;
  totalSolarWatts: number;
  // Sum of every battery's measured AC input this cycle.
  totalAcInputWatts: number;
  // The balance the whole system steers toward zero: solar generation minus
  // total battery AC input. Positive = unconsumed solar (potential export),
  // negative = drawing that much from the grid on top of solar.
  balanceWatts: number;
  devices: {
    sn: string;
    name: string | undefined;
    priority: number;
    batterySoc: number | undefined;
    acInputWatts: number | undefined;
    acOutputWatts: number | undefined;
    targetWatts: number;
    // The allocator's AC-gate decision for this device this cycle (see
    // control/allocator.ts) - what GatedBatteryDriver switches the plug to.
    acOn: boolean;
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
  defaultPriority: PriorityEntry[];
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
    const priorityEntries = readPriority(deps.defaultPriority);
    const prioritySns = priorityEntries.map((e) => e.sn);
    const nameBySn = Object.fromEntries(priorityEntries.map((e) => [e.sn, e.name]));
    const vendorBySn = Object.fromEntries(priorityEntries.map((e) => [e.sn, e.vendor ?? "anker"]));
    const totalWatts = solar.getTotalWatts();

    const statusBySn: Record<string, Result<BatteryStatus>> = {};
    for (const sn of prioritySns) {
      statusBySn[sn] = await getDriver(vendorBySn[sn]).getStatus(sn);
    }
    const socBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, s instanceof Error ? undefined : s.batterySoc]),
    );
    const acInputBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, s instanceof Error ? undefined : s.acInputWatts]),
    );

    const { watts: targets, acOn } = allocate(prioritySns, socBySn, acInputBySn, totalWatts, {
      min: deps.chargeLimitMin,
      max: deps.chargeLimitMax,
      minToCharge: deps.minSolarToChargeWatts,
      houseStandbyWatts: deps.houseStandbyWatts,
    });

    const netWatts = Math.max(0, totalWatts - deps.houseStandbyWatts);
    if (netWatts >= deps.minSolarToChargeWatts && Object.values(acOn).every((on) => !on)) {
      console.warn(`[loop] ${totalWatts}W solar available but every Anker unit is full or unreachable`);
    }

    const deviceStates: StateSnapshot["devices"] = [];
    for (const [i, sn] of prioritySns.entries()) {
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
        priority: i + 1,
        batterySoc: status instanceof Error ? undefined : status.batterySoc,
        acInputWatts: status instanceof Error ? undefined : status.acInputWatts,
        acOutputWatts: status instanceof Error ? undefined : status.acOutputWatts,
        targetWatts: target,
        acOn: acOn[sn],
        lastCommandOk: !(commandResult instanceof Error),
      });
    }

    const totalAcInputWatts = deviceStates.reduce((sum, d) => sum + (d.acInputWatts ?? 0), 0);
    const balanceWatts = totalWatts - totalAcInputWatts;

    const snapshot: StateSnapshot = {
      timestamp: new Date().toISOString(),
      totalSolarWatts: totalWatts,
      totalAcInputWatts,
      balanceWatts,
      devices: deviceStates,
    };
    writeState(deps.stateFilePath, snapshot);
    deps.recordHistory?.(snapshot);

    console.log(
      `[loop] solar=${totalWatts}W input=${totalAcInputWatts}W balance=${balanceWatts >= 0 ? "+" : ""}${balanceWatts}W ` +
        deviceStates
          .map((d) => `${d.name ?? d.sn}:soc=${d.batterySoc ?? "?"}%,target=${d.targetWatts}W`)
          .join(" "),
    );

    await new Promise((r) => setTimeout(r, deps.pollIntervalMs));
  }

  solar.disconnect();
}
