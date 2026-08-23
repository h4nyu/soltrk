import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

// Tied to the ./data volume mount in docker-compose.yml, like state.json.
const PRIORITY_FILE_PATH = "./data/priority.json";

export type PriorityEntry = {
  sn: string;
  name?: string;
  // Key into src/battery/registry.ts. Defaults to "anker" so existing
  // priority.json files (written before other vendors existed) still work.
  vendor?: string;
  priority: number;
};

function isPriorityEntryArray(value: unknown): value is PriorityEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (v) =>
        v !== null &&
        typeof v === "object" &&
        typeof (v as PriorityEntry).sn === "string" &&
        typeof (v as PriorityEntry).priority === "number",
    )
  );
}

function sortedByPriority(entries: PriorityEntry[]): PriorityEntry[] {
  return [...entries]
    .map((e) => ({ ...e, vendor: e.vendor ?? "anker" }))
    .sort((a, b) => a.priority - b.priority);
}

export function writePriority(entries: PriorityEntry[]): void {
  if (!isPriorityEntryArray(entries)) {
    throw new Error('Priority list must be a non-empty array of {sn, priority} (name optional)');
  }
  mkdirSync(dirname(PRIORITY_FILE_PATH), { recursive: true });
  writeFileSync(PRIORITY_FILE_PATH, JSON.stringify(sortedByPriority(entries), null, 2));
}

/**
 * Reads the live priority order (lowest `priority` number charges first),
 * seeding the file from `defaultEntries` the first time - or falling back to
 * it, with a warning, if the file goes missing/corrupt later. Edit
 * data/priority.json directly (reorder the `priority` numbers, e.g. to make
 * 事務室 charge first) to change it without restarting the loop - it's
 * re-read every cycle.
 */
export function readPriority(defaultEntries: PriorityEntry[]): PriorityEntry[] {
  if (!existsSync(PRIORITY_FILE_PATH)) {
    writePriority(defaultEntries);
    return sortedByPriority(defaultEntries);
  }
  try {
    const parsed = JSON.parse(readFileSync(PRIORITY_FILE_PATH, "utf-8"));
    if (isPriorityEntryArray(parsed)) return sortedByPriority(parsed);
    console.warn(`[priority] ${PRIORITY_FILE_PATH} did not match {sn, priority}[] - using default`);
  } catch (err) {
    console.warn(`[priority] failed to read ${PRIORITY_FILE_PATH} - using default:`, (err as Error).message);
  }
  return sortedByPriority(defaultEntries);
}
