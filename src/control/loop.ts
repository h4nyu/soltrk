import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { config } from "../config";
import { SolarSource } from "../tuya/solarSource";
import { getDriver } from "../battery/registry";
import { allocate } from "./allocator";
import { readPriority } from "./priority";

interface StateSnapshot {
  timestamp: string;
  totalSolarWatts: number;
  devices: {
    sn: string;
    name: string | undefined;
    priority: number;
    batterySoc: number | undefined;
    targetWatts: number;
    lastCommandOk: boolean | undefined;
  }[];
}

function writeState(snapshot: StateSnapshot): void {
  mkdirSync(dirname(config.stateFilePath), { recursive: true });
  writeFileSync(config.stateFilePath, JSON.stringify(snapshot, null, 2));
}

export async function runLoop(): Promise<void> {
  const solar = new SolarSource(config.tuyaDevices);
  await solar.connect();

  const lastSent: Record<string, number> = {};
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const priorityEntries = readPriority(config.defaultPriority);
    const prioritySns = priorityEntries.map((e) => e.sn);
    const nameBySn = Object.fromEntries(priorityEntries.map((e) => [e.sn, e.name]));
    const vendorBySn = Object.fromEntries(priorityEntries.map((e) => [e.sn, e.vendor ?? "anker"]));
    const totalWatts = solar.getTotalWatts();

    const socBySn: Record<string, number | undefined> = {};
    for (const sn of prioritySns) {
      const status = await getDriver(vendorBySn[sn]).getStatus(sn);
      socBySn[sn] = status?.batterySoc;
    }

    const targets = allocate(prioritySns, socBySn, totalWatts, {
      min: config.chargeLimitMin,
      max: config.chargeLimitMax,
      step: config.chargeLimitStep,
      minToCharge: config.minSolarToChargeWatts,
    });

    if (totalWatts >= config.minSolarToChargeWatts && Object.values(targets).every((w) => w === 0)) {
      console.warn(`[loop] ${totalWatts}W solar available but every Anker unit is full or unreachable`);
    }

    const deviceStates: StateSnapshot["devices"] = [];
    for (const [i, sn] of prioritySns.entries()) {
      const target = targets[sn];
      let ok: boolean | undefined;
      if (lastSent[sn] !== target) {
        ok = await getDriver(vendorBySn[sn]).setChargeLimit(sn, target);
        if (ok) lastSent[sn] = target;
      }
      deviceStates.push({
        sn,
        name: nameBySn[sn],
        priority: i + 1,
        batterySoc: socBySn[sn],
        targetWatts: target,
        lastCommandOk: ok,
      });
    }

    writeState({
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

    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }

  solar.disconnect();
}
