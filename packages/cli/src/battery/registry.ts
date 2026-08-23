import { BatteryDriver } from "@soltrk/core";
import { NativeAnkerClient } from "@soltrk/anker";
import { loadConfig } from "../config";

// Add a new vendor by writing one BatteryDriver adapter (implementing the
// @soltrk/core port) and registering a factory here - the control loop and
// allocator never branch on vendor. Factories are called lazily (only once,
// on first getDriver() for that vendor) so commands that don't drive
// batteries (e.g. `status`) never need vendor credentials/env vars.
const driverFactories: Record<string, () => BatteryDriver> = {
  anker: () => {
    const config = loadConfig();
    return new NativeAnkerClient(config.ankerEmail, config.ankerPassword, config.ankerCountry);
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
