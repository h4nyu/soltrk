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
    // Not a hardware limit - the least charge worth *starting*. The ~33W
    // conversion overhead is near enough fixed whatever the rate, so a small
    // charge is mostly loss: 50W costs 83W to deliver (60% efficient, and
    // only ~54% once the discharge loss is counted too), where 100W costs
    // 133W (75%) and 200W costs 233W (86%).
    //
    // This used to be pushed as low as the hardware would tolerate, because
    // back then a device that shouldn't charge still had to be sent *some*
    // wattage - there was no way to say zero. Passthrough (see AcMode) says
    // zero properly now, so nothing wants this low any more and the only
    // remaining pressure is upward, toward charging efficiently.
    //
    // What stops it going higher is that it also sets the solar needed
    // before charging starts at all (minSolarToChargeWatts: this + 33W,
    // plus household loads and HOUSE_STANDBY_WATTS on top - about 278W of
    // panel output at 100). Raise it too far and an overcast day never
    // charges anything. 100 is the compromise until house consumption is
    // actually measured; surplus that doesn't charge isn't wasted anyway,
    // it's absorbed by the house at 1:1 rather than stored at 60%.
    //
    // (For the record on the hardware itself: the Anker app's own
    // "交流電池充電" slider stops at 100W, but a live test on 2026-08-24
    // taking it down to 1W showed sub-100W requests do scale the real charge
    // current roughly proportionally, so the old "silently clamped to 100W"
    // note here was wrong - it was the same acInputWatts-includes-
    // passthrough-load confusion diagnosed that day.)
    chargeLimitMin: 100,
    chargeLimitMax: 1200,
    // Constant floor on house consumption that's safe to assume is always
    // drawn regardless of solar - that much of solar output never needs
    // covering by the charger's ceil-rounding margin. Wanted is the floor
    // the house never dips below, not its average, so only loads that never
    // switch off count (lighting doesn't). 0 (default/safe) if unknown.
    // Measured at 100W here, off the retailer's own smart-meter chart for
    // two days the house was empty; .env sets 80, deliberately under the
    // measurement, because overshooting reserves solar the house won't take
    // and backfeeds the remainder while undershooting only imports a few
    // watts. See README. Most of that 100W is still unaccounted for; it's
    // worth more to find than to model.
    houseStandbyWatts: Number(process.env.HOUSE_STANDBY_WATTS ?? 0),
    // Below this SOC, a gated device (see GatedBatteryDriver) is no longer
    // allowed to run off its own battery: its plug closes and it feeds its
    // load from AC in passthrough instead. The physical AC cutoff must never
    // be allowed to fully drain a battery powering something that can't just
    // lose power (e.g. an actual refrigerator). This doesn't charge it -
    // passthrough holds SOC level - it only stops the drain.
    gatedDischargeFloorSocPercent: Number(process.env.GATED_DISCHARGE_FLOOR_SOC_PERCENT ?? 10),
    stateFilePath: STATE_FILE_PATH,
  };
}
