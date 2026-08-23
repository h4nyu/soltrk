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

// Cache of the last successfully parsed file, used as a fallback if a later
// read finds the file missing/corrupt (e.g. a bad manual edit mid-run) -
// there's no env-derived default to fall back to instead, and reusing the
// last known-good order beats crashing the whole loop over a typo.
let lastGood: PriorityEntry[] | undefined;

/**
 * Reads the live priority order (lowest `priority` number charges first) -
 * re-read every cycle, so data/priority.json can be edited directly
 * (reorder the `priority` numbers, e.g. to make 事務室 charge first) to
 * change it without restarting the loop. No env-var seeding: the file
 * itself must exist (see README "One-time setup") since it's the only
 * source of truth, current and initial alike.
 */
export function readPriority(): PriorityEntry[] {
  if (!existsSync(PRIORITY_FILE_PATH)) {
    if (lastGood) {
      console.warn(`[priority] ${PRIORITY_FILE_PATH} missing - using last known priority order`);
      return lastGood;
    }
    throw new Error(
      `Missing ${PRIORITY_FILE_PATH} - see README "One-time setup" for its format ` +
        `([{"sn", "name"?, "vendor"?, "priority"}, ...]).`,
    );
  }
  try {
    const parsed = JSON.parse(readFileSync(PRIORITY_FILE_PATH, "utf-8"));
    if (isPriorityEntryArray(parsed)) {
      lastGood = sortedByPriority(parsed);
      return lastGood;
    }
    console.warn(`[priority] ${PRIORITY_FILE_PATH} did not match {sn, priority}[]`);
  } catch (err) {
    console.warn(`[priority] failed to read ${PRIORITY_FILE_PATH}:`, (err as Error).message);
  }
  if (lastGood) {
    console.warn("[priority] using last known priority order instead");
    return lastGood;
  }
  throw new Error(`${PRIORITY_FILE_PATH} is invalid and no prior good read exists - fix its format.`);
}
