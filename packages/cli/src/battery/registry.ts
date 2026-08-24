import { BatteryDriver } from "@soltrk/core";
import { NativeAnkerClient } from "@soltrk/anker";
import { loadTuyaPlugs } from "@soltrk/tuya";
import { loadConfig } from "../config";
import { GatedBatteryDriver, gatesBySn } from "./gated-battery-driver";

// Add a new vendor by writing one BatteryDriver adapter (implementing the
// @soltrk/core port) and registering a factory here - the control loop and
// allocator never branch on vendor. Factories are called lazily (only once,
// on first getDriver() for that vendor) so commands that don't drive
// batteries (e.g. `status`) never need vendor credentials/env vars.
const driverFactories: Record<string, () => BatteryDriver> = {
  anker: () => {
    const config = loadConfig();
    return NativeAnkerClient({
      email: config.ankerEmail,
      password: config.ankerPassword,
      country: config.ankerCountry,
    });
  },
  // Same underlying Anker devices, gated by a physical Tuya smart plug for
  // whichever sn(s) have a TUYA_PLUG_*_GATES_SN entry - see
  // data/devices.json (set a device's "vendor" field to this) and
  // gatedBatteryDriver.ts.
  "anker-gated": () => {
    const config = loadConfig();
    return GatedBatteryDriver({
      inner: getDriver("anker"),
      plugsBySn: gatesBySn(loadTuyaPlugs()),
      offWatts: config.chargeLimitMin,
      criticalSocPercent: config.gatedCriticalSocPercent,
      recoverySocPercent: config.gatedRecoverySocPercent,
    });
  },
};

const driverInstances: Record<string, BatteryDriver> = {};

export function getDriver(vendor: string): BatteryDriver {
  if (!driverInstances[vendor]) {
    const factory = driverFactories[vendor];
    if (!factory) {
      throw new Error(`Unknown battery vendor "${vendor}" (known: ${Object.keys(driverFactories).join(", ")})`);
    }
    driverInstances[vendor] = factory();
  }
  return driverInstances[vendor];
}
