import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { SolarSource } from "../solar/SolarSource";
import { BatteryDriver, BatteryStatus } from "../battery/BatteryDriver";
import { allocate } from "./allocator";
import { PriorityEntry, readPriority } from "./priority";

type StateSnapshot = {
  timestamp: string;
  totalSolarWatts: number;
  devices: {
    sn: string;
    name: string | undefined;
    priority: number;
    batterySoc: number | undefined;
    acInputWatts: number | undefined;
    acOutputWatts: number | undefined;
    targetWatts: number;
    lastCommandOk: boolean | undefined;
  }[];
};

export type LoopDeps = {
  solar: SolarSource;
  getDriver: (vendor: string) => BatteryDriver;
  defaultPriority: PriorityEntry[];
  pollIntervalMs: number;
  chargeLimitMin: number;
  chargeLimitMax: number;
  chargeRampStepWatts: number;
  minSolarToChargeWatts: number;
  houseStandbyWatts: number;
  stateFilePath: string;
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

    const statusBySn: Record<string, BatteryStatus | undefined> = {};
    for (const sn of prioritySns) {
      statusBySn[sn] = await getDriver(vendorBySn[sn]).getStatus(sn);
    }
    const socBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, s?.batterySoc]),
    );
    const acInputBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, s?.acInputWatts]),
    );

    const targets = allocate(prioritySns, socBySn, acInputBySn, totalWatts, {
      min: deps.chargeLimitMin,
      max: deps.chargeLimitMax,
      minToCharge: deps.minSolarToChargeWatts,
      houseStandbyWatts: deps.houseStandbyWatts,
      rampStepWatts: deps.chargeRampStepWatts,
    });

    const netWatts = Math.max(0, totalWatts - deps.houseStandbyWatts);
    if (
      netWatts >= deps.minSolarToChargeWatts &&
      Object.values(targets).every((w) => w === deps.chargeLimitMin)
    ) {
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
      const ok = await getDriver(vendorBySn[sn]).setChargeLimit(sn, target);
      deviceStates.push({
        sn,
        name: nameBySn[sn],
        priority: i + 1,
        batterySoc: statusBySn[sn]?.batterySoc,
        acInputWatts: statusBySn[sn]?.acInputWatts,
        acOutputWatts: statusBySn[sn]?.acOutputWatts,
        targetWatts: target,
        lastCommandOk: ok,
      });
    }

    writeState(deps.stateFilePath, {
      timestamp: new Date().toISOString(),
      totalSolarWatts: totalWatts,
      devices: deviceStates,
    });

    console.log(
      `[loop] solar=${totalWatts}W ` +
        deviceStates
          .map((d) => `${d.name ?? d.sn}:soc=${d.batterySoc ?? "?"}%,target=${d.targetWatts}W`)
          .join(" "),
    );

    await new Promise((r) => setTimeout(r, deps.pollIntervalMs));
  }

  solar.disconnect();
}
