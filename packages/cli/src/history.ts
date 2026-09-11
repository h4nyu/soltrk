import pino from "pino";
import { CycleRecorder, StateSnapshot } from "@soltrk/core";

// Tied to the ./data volume mount in docker-compose.yml, like state.json and
// devices.json - unlike the container's own stdout logs (rotated, and lost
// entirely when the container is recreated), this survives on the host.
const HISTORY_DIR = "./data";

/**
 * The calendar day a timestamp falls in, as YYYY-MM-DD.
 *
 * Which day that is depends on the timezone, and getting it wrong is not a
 * cosmetic problem here: the container's own zone is UTC, where the boundary
 * lands at 09:00 in Japan and cuts every solar day in half, so a daily file -
 * and every daily total derived from it - would span two afternoons. The zone
 * comes from TZ when it is set and from the system otherwise, which is what
 * `timeZone: undefined` means to Intl; docker-compose.yml mounts the host's
 * /etc/localtime so that "the system" inside the container is the Pi's own
 * zone rather than UTC.
 *
 * en-CA is not a stylistic choice - it is the locale whose numeric date format
 * is already YYYY-MM-DD, so no reassembly is needed.
 */
export const dayKeyFormatter = (timeZone?: string): ((d: Date) => string) => {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (d: Date) => fmt.format(d);
};

/** The zone day boundaries are actually being taken in, for logging. */
export const resolvedTimeZone = (): string =>
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

export const historyFilePath = (day: string): string => `${HISTORY_DIR}/history-${day}.jsonl`;

/** Matches the files pinoCycleRecorder writes, capturing the day. */
export const HISTORY_FILE_RE = /^history-(\d{4}-\d{2}-\d{2})\.jsonl$/;

type OpenDay = {
  day: string;
  logger: pino.Logger;
  dest: { end: () => void };
};

/**
 * Production implementation of @soltrk/core's CycleRecorder port: appends each
 * cycle snapshot as one JSON line, into a file per local calendar day.
 *
 * One file per day rather than one growing file, because the alternative
 * cannot be pruned. pino holds the destination's file descriptor open for the
 * life of the process, so renaming the file leaves the loop writing to the
 * renamed inode, and rewriting it in place races with the append that lands
 * every cycle. A completed day's file is never touched again by this process,
 * so summarising and deleting it is safe with the loop still running - see
 * `soltrk summarize`.
 */
export function pinoCycleRecorder(timeZone?: string): CycleRecorder {
  const dayKey = dayKeyFormatter(timeZone);
  let open: OpenDay | undefined;

  return (snapshot: StateSnapshot) => {
    const day = dayKey(new Date());
    if (open?.day !== day) {
      // Flush and release yesterday's file before opening today's, so the
      // summarizer never finds a half-written last line.
      open?.dest.end();
      const dest = pino.destination({ dest: historyFilePath(day), mkdir: true, sync: true });
      open = {
        day,
        dest: dest as unknown as { end: () => void },
        // base:undefined drops pino's default pid/hostname fields - meaningless
        // noise inside a container. The snapshot carries its own ISO
        // `timestamp`, so pino's `time` field is redundant but harmless (kept:
        // it stamps write time vs. the snapshot's cycle time).
        logger: pino({ base: undefined, timestamp: pino.stdTimeFunctions.isoTime }, dest),
      };
      console.log(`[history] writing ${historyFilePath(day)} (day boundary: ${resolvedTimeZone()})`);
    }
    open.logger.info(snapshot);
  };
}
