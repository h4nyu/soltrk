import { loadTuyaDevices } from "@soltrk/tuya";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Fixed to match the ./data volume mount in docker-compose.yml - not read
// from env. Exported standalone (not gated behind loadConfig()'s required()
// checks) so read-only commands like `status` can use it without needing
// the full Anker/Tuya env vars set.
export const STATE_FILE_PATH = "./data/state.json";

// Deferred until actually needed (called from the "run" command's action,
// not at module load) so that `soltrk --help`/`--version` and other
// commands that don't need it work even when Anker/Tuya env vars aren't set.
export function loadConfig() {
  return {
    tuyaDevices: loadTuyaDevices(),
    ankerEmail: required("ANKER_EMAIL"),
    ankerPassword: required("ANKER_PASSWORD"),
    ankerCountry: process.env.ANKER_COUNTRY ?? "JP",
    // Seeds data/priority.json on first run only - after that, the file (with
    // its per-battery `priority` field) is the live source of truth and can
    // be edited without restarting (see @soltrk/core's control/priority.ts).
    defaultPriority: required("ANKER_PRIORITY_SNS")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((sn, i) => ({ sn, vendor: "anker", priority: i + 1 })),
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
    // Matches the Anker app's own "交流電池充電" slider range (100-1200W,
    // 100W steps) - values outside this range get silently clamped by the
    // device firmware rather than rejected (see control/allocator.ts and
    // the README for why this means true "0W / stop charging" isn't
    // achievable via this setting).
    chargeLimitMin: 100,
    chargeLimitMax: 1200,
    chargeLimitStep: 100,
    // Below this, we don't ask any device to charge at all (avoids 100W-floor
    // grid-draw noise from tiny dawn/dusk solar trickle).
    minSolarToChargeWatts: Number(process.env.MIN_SOLAR_TO_CHARGE_WATTS ?? 150),
    // Constant floor on house consumption (fridge compressor, routers, etc.)
    // that's safe to assume is always drawn regardless of solar - that much
    // of solar output never needs covering by the charger's ceil-rounding
    // margin. 0 (default/safe) if unknown; only raise this to a value you're
    // confident the house never dips below.
    houseStandbyWatts: Number(process.env.HOUSE_STANDBY_WATTS ?? 0),
    stateFilePath: STATE_FILE_PATH,
  };
}
