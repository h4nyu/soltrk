import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { SolarSource } from "../solar/solar-source";
import { AcMode, BatteryDriver, BatteryStatus } from "../battery/battery-driver";
import { Result } from "../result";
import { allocate } from "./allocator";
import { readDevices } from "./devices";

export type StateSnapshot = {
  timestamp: string;
  totalSolarWatts: number;
  // Sum of every battery's measured AC input this cycle.
  totalAcInputWatts: number;
  // Sum of every battery's measured AC output (household load passthrough)
  // this cycle.
  totalAcOutputWatts: number;
  // The balance the whole system steers toward zero: solar generation minus
  // total battery AC input. Positive = unconsumed solar (potential export),
  // negative = drawing that much from the grid on top of solar.
  balanceWatts: number;
  devices: {
    sn: string;
    name: string | undefined;
    batterySoc: number | undefined;
    acInputWatts: number | undefined;
    acOutputWatts: number | undefined;
    targetWatts: number;
    // The allocator's AC-gate decision for this device this cycle (see
    // control/allocator.ts) - what GatedBatteryDriver switches the plug to.
    acOn: boolean;
    // Which of the three AC states the device was actually put into this
    // cycle (see AcMode) - "charge" and "passthrough" both keep the plug
    // closed, but only the former fills the battery (and pays the conversion
    // overhead to do it). This is what the driver reported back, so it
    // reflects a critical-SOC rescue having overridden the allocator rather
    // than the allocator's own request.
    mode: AcMode;
    // The allocator's ranking score for this device this cycle (lower won) -
    // undefined if it wasn't a feasible candidate at all this cycle (full,
    // unknown SOC, or infeasible even with its SOC-urgency bonus).
    score: number | undefined;
    lastCommandOk: boolean | undefined;
  }[];
};

// Port for persisting each cycle's snapshot somewhere durable - the
// composition root decides where (production: appended to a JSONL file on
// the host, see @soltrk/cli's history.ts; tests/CI: simply not provided).
// Core stays free of any logging-library dependency this way.
export type CycleRecorder = (snapshot: StateSnapshot) => void;

export type LoopDeps = {
  solar: SolarSource;
  getDriver: (vendor: string) => BatteryDriver;
  pollIntervalMs: number;
  chargeLimitMin: number;
  chargeLimitMax: number;
  minSolarToChargeWatts: number;
  houseStandbyWatts: number;
  stateFilePath: string;
  recordHistory?: CycleRecorder;
};

function writeState(stateFilePath: string, snapshot: StateSnapshot): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(snapshot, null, 2));
}

export async function runLoop(deps: LoopDeps): Promise<void> {
  const { solar, getDriver } = deps;
  await solar.connect();

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Fed back into allocate() each cycle as previousActiveSn, so a candidate
  // that's already charging gets a sticky bonus over a closely-matched
  // challenger instead of the winner flipping every cycle. Persists through
  // cycles with no winner at all (e.g. overnight) rather than resetting, so
  // the last real incumbent keeps its edge once solar returns.
  let previousActiveSn: string | undefined;

  while (!stopping) {
    const deviceEntries = readDevices();
    const sns = deviceEntries.map((e) => e.sn);
    const nameBySn = Object.fromEntries(deviceEntries.map((e) => [e.sn, e.name]));
    const vendorBySn = Object.fromEntries(deviceEntries.map((e) => [e.sn, e.vendor ?? "anker"]));
    const totalWatts = solar.getTotalWatts();

    const statusBySn: Record<string, Result<BatteryStatus>> = {};
    for (const sn of sns) {
      statusBySn[sn] = await getDriver(vendorBySn[sn]).getStatus(sn);
    }
    const socBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, Result.isErr(s) ? undefined : s.batterySoc]),
    );
    const acInputBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, Result.isErr(s) ? undefined : s.acInputWatts]),
    );
    const acOutputBySn = Object.fromEntries(
      Object.entries(statusBySn).map(([sn, s]) => [sn, Result.isErr(s) ? undefined : s.acOutputWatts]),
    );

    const { watts: targets, acOn, scores, activeSn } = allocate(
      sns,
      socBySn,
      acInputBySn,
      acOutputBySn,
      totalWatts,
      {
        min: deps.chargeLimitMin,
        max: deps.chargeLimitMax,
        minToCharge: deps.minSolarToChargeWatts,
        houseStandbyWatts: deps.houseStandbyWatts,
      },
      previousActiveSn,
    );
    if (activeSn !== undefined) previousActiveSn = activeSn;

    const netWatts = Math.max(0, totalWatts - deps.houseStandbyWatts);
    if (netWatts >= deps.minSolarToChargeWatts && Object.values(acOn).every((on) => !on)) {
      console.warn(`[loop] ${totalWatts.toFixed(1)}W solar available but every Anker unit is full or unreachable`);
    }

    const deviceStates: StateSnapshot["devices"] = [];
    for (const sn of sns) {
      const target = targets[sn];
      // The allocator sets acOn for exactly two cases - the one candidate it
      // picked to charge (activeSn), and any full device worth keeping on AC
      // to pass solar through to its own load. So anything else with acOn is
      // by construction the passthrough case.
      const mode: AcMode = !acOn[sn] ? "battery" : sn === activeSn ? "charge" : "passthrough";
      // Sent every cycle, even when nothing appears to have changed: a gated
      // device's actual decision (see GatedBatteryDriver) can depend on live
      // SOC even when the requested wattage doesn't change, and the devices
      // themselves silently fall back out of passthrough whenever AC is
      // interrupted - so skipping "unchanged" calls would let both drift.
      const commandResult = await getDriver(vendorBySn[sn]).setChargeLimit(sn, target, mode);
      // What the driver actually did, which can differ from what was asked -
      // a critical-SOC rescue turns `battery` into `passthrough` (see
      // GatedBatteryDriver). Fall back to the request only when the command
      // failed outright and there's nothing better to record.
      const appliedMode = Result.isErr(commandResult) ? mode : commandResult;
      const status = statusBySn[sn];
      deviceStates.push({
        sn,
        name: nameBySn[sn],
        batterySoc: Result.isErr(status) ? undefined : status.batterySoc,
        acInputWatts: Result.isErr(status) ? undefined : status.acInputWatts,
        acOutputWatts: Result.isErr(status) ? undefined : status.acOutputWatts,
        targetWatts: target,
        acOn: acOn[sn],
        mode: appliedMode,
        score: scores[sn],
        lastCommandOk: Result.isOk(commandResult),
      });
    }

    const totalAcInputWatts = deviceStates.reduce((sum, d) => sum + (d.acInputWatts ?? 0), 0);
    const totalAcOutputWatts = deviceStates.reduce((sum, d) => sum + (d.acOutputWatts ?? 0), 0);
    const balanceWatts = totalWatts - totalAcInputWatts;

    const snapshot: StateSnapshot = {
      timestamp: new Date().toISOString(),
      totalSolarWatts: totalWatts,
      totalAcInputWatts,
      totalAcOutputWatts,
      balanceWatts,
      devices: deviceStates,
    };
    writeState(deps.stateFilePath, snapshot);
    deps.recordHistory?.(snapshot);

    // Watts are printed as whole numbers here - the readings genuinely
    // fluctuate by more than a watt between cycles, so the decimal was only
    // ever noise. data/state.json keeps the full precision.
    const w = (n: number | undefined) => (n === undefined ? "?" : Math.round(n));
    // Each device reads as its own little power flow: what comes in from AC,
    // through the battery's charge level, and out to its household load -
    // `189>32%>121`. Only `charge` gets a requested wattage alongside it,
    // since for the other two the target is a floor value the device is
    // being told to ignore; same for the score, which only exists for
    // devices that were candidates at all this cycle.
    // One glyph per AcMode, so the mode reads at a glance in a wall of
    // cycles. 🔌 vs 🔋 is where the device's own load is being fed from
    // (grid or its battery); ⚡ is on the grid *and* filling the battery too.
    const MODE_ICON: Record<AcMode, string> = {
      charge: "⚡",
      passthrough: "🔌",
      battery: "🔋",
    };
    const line = (d: StateSnapshot["devices"][number]): string =>
      `${d.name ?? d.sn}:${MODE_ICON[d.mode]}${d.mode === "charge" ? `${w(d.targetWatts)}W` : ""} ` +
      `${w(d.acInputWatts)}W>${d.batterySoc ?? "?"}%>${w(d.acOutputWatts)}W` +
      (d.score === undefined ? "" : ` s=${w(d.score)}W`);
    console.log(
      `[loop] solar=${w(totalWatts)}W bal=${balanceWatts >= 0 ? "+" : ""}${w(balanceWatts)}W | ` +
        deviceStates.map(line).join(" | "),
    );

    await new Promise((r) => setTimeout(r, deps.pollIntervalMs));
  }

  solar.disconnect();
}
