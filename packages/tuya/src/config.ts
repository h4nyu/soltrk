import { existsSync, readFileSync } from "fs";

// Tied to the ./data volume mount in docker-compose.yml, like state.json
// and priority.json. Unlike those, this holds secrets (Tuya local_keys),
// so it lives under the already git-ignored data/ dir rather than .env -
// device/plug IDs and keys change often enough (adding a plug, re-linking
// a device) that maintaining them as numbered env vars in both .env and
// docker-compose.yml's x-env block (with its shell-escaping footguns for
// keys containing `$`) was worse than a plain JSON file. Read once at
// process start, same as the env vars it replaced - editing it still needs
// a restart to take effect, just not a docker-compose config change.
const TUYA_CONFIG_PATH = "./data/tuya.json";

type TuyaConfigFile = {
  devices?: Array<{ name?: string; id: string; key: string; powerDp?: string; powerScale?: number }>;
  plugs?: Array<{ id: string; key: string; switchDp?: string; gatesSn: string }>;
};

function readTuyaConfigFile(): TuyaConfigFile {
  if (!existsSync(TUYA_CONFIG_PATH)) {
    throw new Error(
      `Missing ${TUYA_CONFIG_PATH} - see README "One-time setup" for its format ` +
        `({"devices": [{"id", "key", ...}], "plugs": [{"id", "key", "gatesSn", ...}]}).`,
    );
  }
  return JSON.parse(readFileSync(TUYA_CONFIG_PATH, "utf-8"));
}

export type TuyaDeviceConfig = {
  name: string;
  id: string;
  key: string;
  // No IP: it's resolved dynamically via UDP broadcast (tuyapi's find())
  // on every connect/reconnect instead of being pinned in config, since
  // devices on this network don't have DHCP reservations and their IPs
  // drift (see SolarSource/SmartPlug).
  powerDp: string;
  // Raw Tuya dp value is divided by this to get Watts (Tuya often reports
  // power in tenths of a watt). Confirm the right value for your device
  // with `npm run tuya:discover` before trusting the numbers.
  powerScale: number;
};

export function loadTuyaDevices(): TuyaDeviceConfig[] {
  const file = readTuyaConfigFile();
  const devices = (file.devices ?? []).map((d, i) => ({
    name: d.name ?? `gtb800-${i + 1}`,
    id: d.id,
    key: d.key,
    powerDp: d.powerDp ?? "19",
    powerScale: d.powerScale ?? 10,
  }));
  if (devices.length === 0) {
    throw new Error(`No Tuya devices configured in ${TUYA_CONFIG_PATH}'s "devices" array.`);
  }
  return devices;
}

export type TuyaPlugConfig = {
  id: string;
  key: string;
  // No IP - see TuyaDeviceConfig.
  // Boolean on/off dp code - "1" is the standard default for most Tuya
  // smart plugs, confirm with `npm run tuya:discover` if a plug doesn't
  // respond.
  switchDp: string;
  // Serial number of the battery this plug's AC output feeds - ties the
  // plug to a BatteryDriver.setChargeLimit() call in GatedBatteryDriver.
  gatesSn: string;
};

/**
 * Unlike loadTuyaDevices(), an empty result is valid here - not every
 * battery needs a physical AC cutoff, so no "plugs" entry being present
 * just means no device is gated.
 */
export function loadTuyaPlugs(): TuyaPlugConfig[] {
  const file = readTuyaConfigFile();
  return (file.plugs ?? []).map((p) => ({
    id: p.id,
    key: p.key,
    switchDp: p.switchDp ?? "1",
    gatesSn: p.gatesSn,
  }));
}
