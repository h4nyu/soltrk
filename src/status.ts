import { readFileSync } from "fs";
import { config } from "./config";

export function printStatus(): void {
  let raw: string;
  try {
    raw = readFileSync(config.stateFilePath, "utf-8");
  } catch {
    console.log(`No state file yet at ${config.stateFilePath} - is "soltrk run" running?`);
    return;
  }
  const snapshot = JSON.parse(raw);
  console.log(`as of ${snapshot.timestamp}`);
  console.log(`solar: ${snapshot.totalSolarWatts} W`);
  for (const d of snapshot.devices) {
    console.log(
      `  #${d.priority} ${d.name ?? d.sn} (${d.sn})  soc=${d.batterySoc ?? "unknown"}%  target=${d.targetWatts}W` +
        (d.lastCommandOk === false ? "  (last command FAILED)" : ""),
    );
  }
}
