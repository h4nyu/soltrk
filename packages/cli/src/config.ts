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
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 60_000),
    // The Anker app's own "交流電池充電" slider only goes down to 100W, but a
    // live test on 2026-08-24 (chargeLimitMin briefly lowered to 1) showed
    // sub-100W requests (down to ~28W) DO scale the actual charge current
    // roughly proportionally - the "gets silently clamped to 100W" claim
    // that used to live here looks like it was really the same
    // acInputWatts-includes-passthrough-load confusion diagnosed that day,
    // not a real firmware clamp. That same test also sent full/passthrough
    // devices a 1W request (never sent by the app itself, since it's below
    // the slider's own floor) right before 冷蔵庫's status reads briefly
    // started failing - probably unrelated, but not worth finding out the
    // hard way on hardware powering an actual refrigerator. Settled on 50
    // as a floor that's solidly inside the range already confirmed working
    // (28-119W tested) while staying well clear of that 1W value.
    chargeLimitMin: 50,
    chargeLimitMax: 1200,
    // Below this, we don't ask any device to charge at all (avoids 100W-floor
    // grid-draw noise from tiny dawn/dusk solar trickle).
    minSolarToChargeWatts: Number(process.env.MIN_SOLAR_TO_CHARGE_WATTS ?? 130),
    // Constant floor on house consumption (fridge compressor, routers, etc.)
    // that's safe to assume is always drawn regardless of solar - that much
    // of solar output never needs covering by the charger's ceil-rounding
    // margin. 0 (default/safe) if unknown; only raise this to a value you're
    // confident the house never dips below.
    houseStandbyWatts: Number(process.env.HOUSE_STANDBY_WATTS ?? 0),
    // Below this SOC, a gated device (see GatedBatteryDriver) is no longer
    // allowed to run off its own battery: its plug closes and it feeds its
    // load from AC in passthrough instead. The physical AC cutoff must never
    // be allowed to fully drain a battery powering something that can't just
    // lose power (e.g. an actual refrigerator). This doesn't charge it -
    // passthrough holds SOC level - it only stops the drain.
    gatedDischargeFloorSocPercent: Number(process.env.GATED_DISCHARGE_FLOOR_SOC_PERCENT ?? 10),
    // How far back up a device has to be charged before it's allowed to run
    // on its battery again. Above the floor so a device that just touched it
    // has to build a real buffer first, rather than being handed straight
    // back to discharging on the next watt of charge.
    gatedDischargeResumeSocPercent: Number(process.env.GATED_DISCHARGE_RESUME_SOC_PERCENT ?? 40),
    stateFilePath: STATE_FILE_PATH,
  };
}
