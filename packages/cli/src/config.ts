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
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 30_000),
    // Not a hardware limit - the least charge worth *starting*. The ~33W
    // conversion overhead is near enough fixed whatever the rate, so a small
    // charge is inefficient: 50W costs 83W to deliver (60%, and ~54% once
    // the discharge loss is counted), where 100W costs 133W (75%).
    //
    // That argued for keeping this high, on the reasoning that surplus which
    // doesn't charge is absorbed by the house at 1:1 and so beats storing it
    // at 60%. But there's no export contract here: surplus the house doesn't
    // take is given to the grid for nothing, and against 0% an inefficient
    // charge wins easily. Storing W costs W+33 and returns 0.9W, so it pays
    // whenever the surplus clears roughly the overhead.
    //
    // This value also sets the solar needed before charging starts at all
    // (minSolarToChargeWatts: this + 33W, plus household loads and
    // HOUSE_STANDBY_WATTS on top), so raising it widens the band of
    // generation that gets exported for nothing - 133W wide at 100, which
    // on 2026-08-30 left 55W being exported at 236W of generation.
    //
    // It is not free to pick, though: it has to cancel out however far
    // HOUSE_STANDBY_WATTS sits below the real house draw, or charging starts
    // before the true surplus covers the overhead. Charging begins at
    // `solar = this + 33 + standby + loads`, where the real surplus is
    // `this + 33 + standby - house`, and that must clear the 33W overhead -
    // so this = house - standby. At a measured 99W house and 70W standby
    // that is ~30. Change one and the other has to move with it.
    //
    // (On the hardware: the Anker app's own "交流電池充電" slider stops at
    // 100W, but a live test on 2026-08-24 taking it down to 1W showed
    // sub-100W requests do scale the real charge current roughly
    // proportionally, so this can go well below what the app offers.)
    chargeLimitMin: 30,
    chargeLimitMax: 1200,
    // Constant floor on house consumption that's safe to assume is always
    // drawn regardless of solar - that much of solar output never needs
    // covering by the charger's ceil-rounding margin. Wanted is the floor
    // the house never dips below, not its average, so only loads that never
    // switch off count (lighting doesn't). 0 (default/safe) if unknown.
    // Measured at 99W (see README), and deliberately set below that: while
    // charging, the grid draw settles at exactly `house - this`, so the gap
    // is the operating bias. 70 buys about 29W continuously rather than
    // risking any export, which is the preference here - the round trip on
    // those watts costs a tenth of them, where exported watts are lost
    // whole. Most of that 99W is still unaccounted for; it's worth more to
    // find than to model.
    // docker-compose.yml always supplies this, and is where the value is
    // set; the fallback here only applies when running outside compose, and
    // is kept equal to it so the two can't drift unnoticed.
    houseStandbyWatts: Number(process.env.HOUSE_STANDBY_WATTS ?? 70),
    // Below this SOC, a gated device (see GatedBatteryDriver) is no longer
    // allowed to run off its own battery: its plug closes and it feeds its
    // load from AC in passthrough instead. The physical AC cutoff must never
    // be allowed to fully drain a battery powering something that can't just
    // lose power (e.g. an actual refrigerator). This doesn't charge it -
    // passthrough holds SOC level - it only stops the drain.
    //
    // Set to the devices' own reserve (6%, configured in the Anker app).
    // That reserve is not a discharge cutoff - left on battery the units go
    // past it, 4% and 5% both recorded while still delivering their load -
    // so stopping the drain is this floor's job and can't be delegated.
    // What the devices do instead is charge themselves back to 6% whenever
    // AC is present, which is why a higher floor buys nothing: the SOC
    // reading is unreliable down here (a steady 6% jumped to 2% in one
    // minute, the gauge recalibrating, not the pack draining), but the
    // moment this floor engages the unit is on AC and repairs it itself.
    // See README for why the top-up churn at the reserve isn't a reason to
    // sit higher either.
    gatedDischargeFloorSocPercent: Number(process.env.GATED_DISCHARGE_FLOOR_SOC_PERCENT ?? 6),
    stateFilePath: STATE_FILE_PATH,
  };
}
