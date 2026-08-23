import { runLoop } from "@soltrk/core";
import { SolarSource as TuyaSolarSource } from "@soltrk/tuya";
import { config } from "./config";
import { getDriver } from "./battery/registry";
import { printStatus } from "./status";

const command = process.argv[2] ?? "run";

switch (command) {
  case "run":
    runLoop({
      solar: new TuyaSolarSource(config.tuyaDevices),
      getDriver,
      defaultPriority: config.defaultPriority,
      pollIntervalMs: config.pollIntervalMs,
      chargeLimitMin: config.chargeLimitMin,
      chargeLimitMax: config.chargeLimitMax,
      chargeLimitStep: config.chargeLimitStep,
      minSolarToChargeWatts: config.minSolarToChargeWatts,
      houseStandbyWatts: config.houseStandbyWatts,
      stateFilePath: config.stateFilePath,
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
    break;
  case "status":
    printStatus();
    break;
  default:
    console.error(`Unknown command: ${command} (expected "run" or "status")`);
    process.exit(1);
}
