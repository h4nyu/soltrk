import { BatteryDriver } from "@soltrk/core";
import { NativeAnkerClient } from "@soltrk/anker";
import { config } from "../config";

// Add a new vendor by writing one BatteryDriver adapter (implementing the
// @soltrk/core port) and registering it here - the control loop and
// allocator never branch on vendor.
const drivers: Record<string, BatteryDriver> = {
  anker: new NativeAnkerClient(config.ankerEmail, config.ankerPassword, config.ankerCountry),
};

export function getDriver(vendor: string): BatteryDriver {
  const driver = drivers[vendor];
  if (!driver) {
    throw new Error(`Unknown battery vendor "${vendor}" (known: ${Object.keys(drivers).join(", ")})`);
  }
  return driver;
}
