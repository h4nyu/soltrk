import { loadTuyaDevices } from "@soltrk/tuya";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  tuyaDevices: loadTuyaDevices(),
  ankerEmail: required("ANKER_EMAIL"),
  ankerPassword: required("ANKER_PASSWORD"),
  ankerCountry: process.env.ANKER_COUNTRY ?? "JP",
  // Seeds data/priority.json on first run only - after that, the file (with
  // its per-battery `priority` field) is the live source of truth and can be
  // edited without restarting (see @soltrk/core's control/priority.ts).
  defaultPriority: required("ANKER_PRIORITY_SNS")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sn, i) => ({ sn, vendor: "anker", priority: i + 1 })),
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 15_000),
  chargeLimitMin: 200,
  chargeLimitMax: 1000,
  chargeLimitStep: 100,
  // Below this, we don't ask any device to charge at all (avoids 100W-floor
  // grid-draw noise from tiny dawn/dusk solar trickle).
  minSolarToChargeWatts: Number(process.env.MIN_SOLAR_TO_CHARGE_WATTS ?? 150),
  // Constant floor on house consumption (fridge compressor, routers, etc.)
  // that's safe to assume is always drawn regardless of solar - that much of
  // solar output never needs covering by the charger's ceil-rounding margin.
  // 0 (default/safe) if unknown; only raise this to a value you're confident
  // the house never dips below.
  houseStandbyWatts: Number(process.env.HOUSE_STANDBY_WATTS ?? 0),
  // Fixed to match the ./data volume mount in docker-compose.yml - not read from env.
  stateFilePath: "./data/state.json",
};
