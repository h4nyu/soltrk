import scheduler from "node-schedule";
import { Result } from "@soltrk/core";
import { resolvedTimeZone } from "./history";
import { summarize } from "./summary";

/**
 * Runs `summarize` on a recurring schedule, in its own process.
 *
 * Its own process on purpose, and this is the whole reason the service exists:
 * the rollup reads a day of JSONL and builds a month of accumulators, and
 * doing that inside the control loop would put a nightly memory and CPU spike
 * - and any bug in it - inside the process managing household power, whose
 * every restart is another Anker cloud login. The sibling picomanager project
 * reached the same shape for the same reason, and this follows its choice of
 * node-schedule so there is one scheduling library across both repos rather
 * than two.
 *
 * There is deliberately no persisted "last run" state. picomanager has to
 * rebuild its schedule from the database on restart because its jobs are
 * one-shot rows; here the filesystem already is the durable state - which raw
 * files still exist, and which of them each month's summary lists as folded,
 * together decide exactly what remains to do. That makes the job idempotent,
 * and idempotence makes restart recovery free: it simply runs once at startup
 * and catches up whatever a stopped Pi missed.
 */
export const runScheduler = (opts: {
  dataDir: string;
  retentionDays: number;
  cron: string;
  timeZone?: string;
}): Result<scheduler.Job> => {
  const timeZone = opts.timeZone ?? resolvedTimeZone();
  let running = false;

  const runOnce = async (why: string): Promise<void> => {
    // node-schedule has no overlap guard of its own - picomanager was bitten
    // by the same gap. A rollup takes seconds and a tick comes once a night,
    // so this should never fire; if it ever does, skipping is right, because
    // the next tick will pick up whatever this run would have.
    if (running) {
      console.warn(`[schedule] ${why}: previous summarize still running - skipped`);
      return;
    }
    running = true;
    try {
      const res = await summarize({
        dataDir: opts.dataDir,
        retentionDays: opts.retentionDays,
        timeZone: opts.timeZone,
      });
      const folded = res.folded.reduce((n, f) => n + f.records, 0);
      console.log(
        `[schedule] ${why}: folded ${folded} cycles from ${res.folded.length} file(s), ` +
          `deleted ${res.deleted.length}`,
      );
      for (const f of res.folded) console.log(`[schedule]   ${f.source} -> ${f.months.join(", ")}`);
      for (const d of res.deleted) console.log(`[schedule]   deleted ${d}`);
    } catch (err) {
      // Never let a bad night take the scheduler down: the next tick retries,
      // and the job is idempotent so nothing is lost by having failed.
      console.error(`[schedule] ${why} failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  const job = scheduler.scheduleJob({ rule: opts.cron, tz: timeZone }, () => void runOnce("tick"));
  if (job === null) {
    return Object.assign(new Error(`invalid cron expression: ${opts.cron}`), { kind: "bad-cron" as const });
  }

  const next = job.nextInvocation();
  console.log(
    `[schedule] summarize at "${opts.cron}" (${timeZone}); ` +
      `next ${next ? next.toISOString() : "never - the rule matches no future time"}`,
  );
  // Catch up immediately in case the Pi was off at the scheduled hour. Delayed
  // a little so the log line above lands first and a restart loop cannot spin.
  setTimeout(() => void runOnce("startup"), 5_000);
  return job;
};
