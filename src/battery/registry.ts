import { config } from "../config";
import { AnkerClient } from "../anker/ankerClient";
import { BatteryDriver } from "./BatteryDriver";

// Add a new vendor by writing one BatteryDriver adapter and registering it
// here - the control loop and allocator never branch on vendor.
const drivers: Record<string, BatteryDriver> = {
  anker: new AnkerClient(config.ankerDriverUrl),
};

export function getDriver(vendor: string): BatteryDriver {
  const driver = drivers[vendor];
  if (!driver) {
    throw new Error(`Unknown battery vendor "${vendor}" (known: ${Object.keys(drivers).join(", ")})`);
  }
  return driver;
}
