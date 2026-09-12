import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result } from "@soltrk/core";
import { runScheduler } from "./schedule";

describe("runScheduler", () => {
  test("reports a cron expression it cannot parse instead of running silently", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "soltrk-sched-"));
    // node-schedule returns null rather than throwing, which is easy to ignore -
    // a typo in SUMMARIZE_CRON would otherwise leave a container that starts
    // cleanly, logs nothing and never rolls anything up.
    const job = runScheduler({ dataDir, retentionDays: 60, cron: "every night please" });

    assert.ok(Result.isErr(job));
    assert.match(job.message, /invalid cron expression/);
    assert.equal((job as Error & { kind?: string }).kind, "bad-cron");
  });

  test("accepts a valid expression and reports when it will next fire", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "soltrk-sched-"));
    const job = runScheduler({ dataDir, retentionDays: 60, cron: "0 3 * * *", timeZone: "Asia/Tokyo" });

    assert.ok(!Result.isErr(job));
    const next = job.nextInvocation();
    assert.ok(next, "a daily rule always has a next occurrence");
    assert.equal(next.getTime() > Date.now(), true);
    job.cancel();
  });
});
