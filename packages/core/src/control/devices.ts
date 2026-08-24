import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

// Tied to the ./data volume mount in docker-compose.yml, like state.json.
const DEVICES_FILE_PATH = "./data/devices.json";

export type DeviceEntry = {
  sn: string;
  name?: string;
  // Key into src/battery/registry.ts. Defaults to "anker" so existing
  // devices.json files (written before other vendors existed) still work.
  vendor?: string;
};

function isDeviceEntryArray(value: unknown): value is DeviceEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (v) => v !== null && typeof v === "object" && typeof (v as DeviceEntry).sn === "string",
    )
  );
}

function normalized(entries: DeviceEntry[]): DeviceEntry[] {
  return entries.map((e) => ({ ...e, vendor: e.vendor ?? "anker" }));
}

export function writeDevices(entries: DeviceEntry[]): void {
  if (!isDeviceEntryArray(entries)) {
    throw new Error("Device list must be a non-empty array of {sn} (name/vendor optional)");
  }
  mkdirSync(dirname(DEVICES_FILE_PATH), { recursive: true });
  writeFileSync(DEVICES_FILE_PATH, JSON.stringify(normalized(entries), null, 2));
}

// Cache of the last successfully parsed file, used as a fallback if a later
// read finds the file missing/corrupt (e.g. a bad manual edit mid-run) -
// there's no env-derived default to fall back to instead, and reusing the
// last known-good list beats crashing the whole loop over a typo.
let lastGood: DeviceEntry[] | undefined;

/**
 * Reads the list of batteries the loop controls - re-read every cycle, so
 * data/devices.json can be edited directly (add/remove a device) without
 * restarting the loop. No env-var seeding: the file itself must exist (see
 * README "One-time setup") since it's the only source of truth, current and
 * initial alike. Which device gets charged each cycle is decided fresh every
 * time by the allocator's balance evaluation (see control/allocator.ts),
 * not by this list's order - there's no priority to configure here.
 */
export function readDevices(): DeviceEntry[] {
  if (!existsSync(DEVICES_FILE_PATH)) {
    if (lastGood) {
      console.warn(`[devices] ${DEVICES_FILE_PATH} missing - using last known device list`);
      return lastGood;
    }
    throw new Error(
      `Missing ${DEVICES_FILE_PATH} - see README "One-time setup" for its format ` +
        `([{"sn", "name"?, "vendor"?}, ...]).`,
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(DEVICES_FILE_PATH, "utf-8"));
    if (isDeviceEntryArray(parsed)) {
      lastGood = normalized(parsed);
      return lastGood;
    }
    console.warn(`[devices] ${DEVICES_FILE_PATH} did not match {sn}[]`);
  } catch (err) {
    console.warn(`[devices] failed to read ${DEVICES_FILE_PATH}:`, (err as Error).message);
  }
  if (lastGood) {
    console.warn("[devices] using last known device list instead");
    return lastGood;
  }
  throw new Error(`${DEVICES_FILE_PATH} is invalid and no prior good read exists - fix its format.`);
}
