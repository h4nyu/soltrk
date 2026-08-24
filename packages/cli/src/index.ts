#!/usr/bin/env -S npx tsx
import { readFileSync } from "fs";
import { join } from "path";
import { Command } from "commander";
import { Result, runLoop } from "@soltrk/core";
import { captureMqtt, getBindDevices, login } from "@soltrk/anker";
import { discover, SolarSource as TuyaSolarSource } from "@soltrk/tuya";
import { loadConfig } from "./config";
import { getDriver } from "./battery/registry";
import { pinoCycleRecorder } from "./history";
import { printStatus } from "./status";

const pkg = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));

function ankerCreds(): { email: string; password: string; country: string } {
  const email = process.env.ANKER_EMAIL;
  const password = process.env.ANKER_PASSWORD;
  if (!email || !password) {
    console.error("Missing ANKER_EMAIL / ANKER_PASSWORD env vars");
    process.exit(1);
  }
  return { email, password, country: process.env.ANKER_COUNTRY ?? "JP" };
}

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
      solar: TuyaSolarSource({ configs: config.tuyaDevices }),
      getDriver,
      pollIntervalMs: config.pollIntervalMs,
      chargeLimitMin: config.chargeLimitMin,
      chargeLimitMax: config.chargeLimitMax,
      minSolarToChargeWatts: config.minSolarToChargeWatts,
      houseStandbyWatts: config.houseStandbyWatts,
      stateFilePath: config.stateFilePath,
      recordHistory: pinoCycleRecorder(),
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

program
  .command("discover <id> <key>")
  .description("Dump every dp a Tuya device reports, to identify its power dp/scale before adding it to data/tuya.json")
  .action(async (id: string, key: string) => {
    await discover(id, key);
    process.exit(0);
  });

program
  .command("capture-mqtt <device_sn>")
  .description("Log the Anker app's own MQTT traffic for one device, to reverse engineer a new command")
  .action(async (deviceSn: string) => {
    const { email, password, country } = ankerCreds();
    await captureMqtt(deviceSn, email, password, country).catch((err) => {
      console.error(err.message ?? err);
      process.exit(1);
    });
  });

program
  .command("devices")
  .description("List Anker device serials bound to this account (for data/devices.json)")
  .action(async () => {
    const { email, password, country } = ankerCreds();
    const session = await login(email, password, country);
    if (Result.isErr(session)) {
      console.error(session.message);
      process.exit(1);
    }
    const devices = await getBindDevices(session);
    if (Result.isErr(devices)) {
      console.error(devices.message);
      process.exit(1);
    }
    console.log(devices);
    process.exit(0);
  });

program.parse();
