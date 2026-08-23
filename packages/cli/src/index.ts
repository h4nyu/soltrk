#!/usr/bin/env -S npx tsx
import { readFileSync } from "fs";
import { join } from "path";
import { Command } from "commander";
import { runLoop } from "@soltrk/core";
import { SolarSource as TuyaSolarSource } from "@soltrk/tuya";
import { loadConfig } from "./config";
import { getDriver } from "./battery/registry";
import { printStatus } from "./status";

const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

const program = new Command();

program
  .name("soltrk")
  .description("Route solar generation into Anker SOLIX batteries without backfeeding the grid")
  .version(pkg.version);

program
  .command("run")
  .description("Start the control loop: read solar output and set battery charge limits")
  .action(() => {
    const config = loadConfig();
    runLoop({
      solar: new TuyaSolarSource(config.tuyaDevices),
      getDriver,
      defaultPriority: config.defaultPriority,
      pollIntervalMs: config.pollIntervalMs,
      chargeLimitMin: config.chargeLimitMin,
      chargeLimitMax: config.chargeLimitMax,
      chargeRampStepWatts: config.chargeRampStepWatts,
      minSolarToChargeWatts: config.minSolarToChargeWatts,
      houseStandbyWatts: config.houseStandbyWatts,
      stateFilePath: config.stateFilePath,
    }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  });

program
  .command("status")
  .description("Print the most recently recorded solar/battery snapshot")
  .action(() => {
    printStatus();
  });

program.parse();
