import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { config } from "../config";
import { SolarSource } from "../tuya/solarSource";
import { AnkerClient } from "../anker/ankerClient";
import { allocate } from "./allocator";

interface StateSnapshot {
  timestamp: string;
  totalSolarWatts: number;
  devices: {
    sn: string;
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
  const anker = new AnkerClient(config.ankerDriverUrl);
  await solar.connect();

  const lastSent: Record<string, number> = {};
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const totalWatts = solar.getTotalWatts();

    const socBySn: Record<string, number | undefined> = {};
    for (const sn of config.ankerPrioritySns) {
      const status = await anker.getStatus(sn);
      socBySn[sn] = status?.battery_soc as number | undefined;
    }

    const targets = allocate(config.ankerPrioritySns, socBySn, totalWatts, {
      min: config.chargeLimitMin,
      max: config.chargeLimitMax,
      step: config.chargeLimitStep,
      minToCharge: config.minSolarToChargeWatts,
    });

    if (totalWatts >= config.minSolarToChargeWatts && Object.values(targets).every((w) => w === 0)) {
      console.warn(`[loop] ${totalWatts}W solar available but every Anker unit is full or unreachable`);
    }

    const deviceStates: StateSnapshot["devices"] = [];
    for (const [i, sn] of config.ankerPrioritySns.entries()) {
      const target = targets[sn];
      let ok: boolean | undefined;
      if (lastSent[sn] !== target) {
        ok = await anker.setChargeLimit(sn, target);
        if (ok) lastSent[sn] = target;
      }
      deviceStates.push({
        sn,
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
        deviceStates.map((d) => `${d.sn}:soc=${d.batterySoc ?? "?"}%,target=${d.targetWatts}W`).join(" "),
    );

    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }

  solar.disconnect();
}
