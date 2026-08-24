import pino from "pino";
import { CycleRecorder } from "@soltrk/core";

// Tied to the ./data volume mount in docker-compose.yml, like state.json and
// devices.json - unlike the container's own stdout logs (rotated, and lost
// entirely when the container is recreated), this survives on the host.
// Append-only JSONL, one record per control cycle: greppable with jq, and
// trivially loadable for plotting later. At one line per minute this grows
// on the order of ~1MB/day - no rotation for now, prune by hand if it ever
// matters.
const HISTORY_FILE_PATH = "./data/history.jsonl";

/**
 * Production implementation of @soltrk/core's CycleRecorder port: appends
 * each cycle snapshot as one JSON line via pino. Built lazily (only when the
 * `run` command actually starts the loop) so importing this module doesn't
 * touch the filesystem.
 */
export function pinoCycleRecorder(): CycleRecorder {
  // base:undefined drops pino's default pid/hostname fields - meaningless
  // noise inside a container. The snapshot carries its own ISO `timestamp`,
  // so pino's `time` field is redundant but harmless (kept: it stamps write
  // time vs. the snapshot's cycle time).
  const logger = pino(
    { base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.destination({ dest: HISTORY_FILE_PATH, mkdir: true, sync: true }),
  );
  return (snapshot) => {
    logger.info(snapshot);
  };
}
