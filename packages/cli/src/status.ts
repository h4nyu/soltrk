import { readFileSync } from "fs";
import { STATE_FILE_PATH } from "./config";

export function printStatus(): void {
  let raw: string;
  try {
    raw = readFileSync(STATE_FILE_PATH, "utf-8");
  } catch {
    console.log(`No state file yet at ${STATE_FILE_PATH} - is "soltrk run" running?`);
    return;
  }
  const snapshot = JSON.parse(raw);
  console.log(`as of ${snapshot.timestamp}`);
  console.log(`solar: ${snapshot.totalSolarWatts} W`);
  for (const d of snapshot.devices) {
    console.log(
      `  ${d.name ?? d.sn} (${d.sn})  soc=${d.batterySoc ?? "unknown"}%  ` +
        `in=${d.acInputWatts ?? "?"}W out=${d.acOutputWatts ?? "?"}W  target=${d.targetWatts}W` +
        (d.acOn ? "  [charging]" : "") +
        (d.lastCommandOk === false ? "  (last command FAILED)" : ""),
    );
  }
}
