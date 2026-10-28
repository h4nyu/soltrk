import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayKeyFormatter } from "./history";
import { MonthSummary, summarize, summaryFilePath } from "./summary";

const TOKYO = "Asia/Tokyo";

describe("dayKeyFormatter", () => {
  test("puts an instant in the day its own timezone is having", () => {
    // 2026-09-30T15:30Z is already 2026-10-01 00:30 in Tokyo. Filing it under
    // the UTC day would cut the local day - and the month - in the wrong place.
    const t = new Date("2026-09-30T15:30:00Z");
    assert.equal(dayKeyFormatter(TOKYO)(t), "2026-10-01");
    assert.equal(dayKeyFormatter("UTC")(t), "2026-09-30");
  });

  test("a whole solar day lands in one file", () => {
    const day = dayKeyFormatter(TOKYO);
    // 06:00 and 18:00 JST, either side of the UTC boundary at 09:00 JST.
    assert.equal(day(new Date("2026-09-08T21:00:00Z")), "2026-09-09");
    assert.equal(day(new Date("2026-09-09T09:00:00Z")), "2026-09-09");
  });
});

/** Extra fields a real record also carries (solarByPanel, devices) are
 *  deliberately left out: summary.ts only keeps the three global totals now,
 *  so a fixture for it has no reason to include detail it would just ignore. */
const line = (iso: string, solar: number, acIn = 40, acOut = 0): string =>
  JSON.stringify({
    timestamp: iso,
    totalSolarWatts: solar,
    totalAcInputWatts: acIn,
    totalAcOutputWatts: acOut,
    balanceWatts: solar - acIn,
  }) + "\n";

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "soltrk-sum-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

const readMonth = async (dir: string, month: string): Promise<MonthSummary> =>
  JSON.parse(await readFile(join(dir, "summaries", `${month}.json`), "utf8")) as MonthSummary;

describe("summarize", () => {
  const now = new Date("2026-09-10T03:00:00Z"); // 12:00 JST on the 10th

  test("folds a completed day into its month as a single day's sums and counts", async () => {
    const dir = await fixture({
      "history-2026-09-08.jsonl":
        line("2026-09-08T00:10:00Z", 100) + line("2026-09-08T00:40:00Z", 200) + line("2026-09-08T01:10:00Z", 300),
    });
    const res = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    assert.deepEqual(
      res.folded.map((f) => [f.source, f.months, f.records]),
      [["history-2026-09-08.jsonl", ["2026-09"], 3]],
    );

    const s = await readMonth(dir, "2026-09");
    // All three cycles land on the same JST calendar day (09:10-10:10 JST),
    // so one day's worth of entries, not one per hour.
    assert.equal(s.days.length, 1);
    // Sum and count, not a mean - so the day can be re-averaged with others.
    assert.deepEqual(s.days[0].solar, [600, 3]);
    assert.deepEqual(s.sources, ["history-2026-09-08.jsonl"]);
    assert.equal(s.timeZone, TOKYO);
  });

  test("splits records either side of local midnight, not UTC midnight", async () => {
    // 23:30 and 00:30 JST - an hour apart, but on different calendar days in
    // Tokyo despite both falling on 2026-09-08 in UTC.
    const dir = await fixture({
      "history-2026-09-08.jsonl":
        line("2026-09-08T14:30:00Z", 10) + line("2026-09-08T15:30:00Z", 20),
    });
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    const s = await readMonth(dir, "2026-09");
    assert.equal(s.days.length, 2);
    assert.deepEqual(
      s.days.map((d) => d.solar),
      [[10, 1], [20, 1]],
    );
  });

  test("ignores per-device and per-panel detail in the raw record", async () => {
    const dir = await fixture({
      "history-2026-09-08.jsonl":
        JSON.stringify({
          timestamp: "2026-09-08T00:10:00Z",
          totalSolarWatts: 300,
          totalAcInputWatts: 40,
          totalAcOutputWatts: 0,
          balanceWatts: 260,
          solarByPanel: { "gtb800-1": 100, "gtb800-2": 200 },
          devices: [{ sn: "A", name: "冷蔵庫", batterySoc: 50, acInputWatts: 40, targetWatts: 30, mode: "charge" }],
        }) + "\n",
    });
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    const s = await readMonth(dir, "2026-09") as unknown as Record<string, unknown>;
    assert.deepEqual((s.days as { solar: [number, number] }[])[0].solar, [300, 1]);
    assert.equal("devices" in s, false);
  });

  test("running twice folds nothing twice", async () => {
    const dir = await fixture({
      "history-2026-09-08.jsonl": line("2026-09-08T00:10:00Z", 100),
    });
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    const second = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });

    assert.deepEqual(second.folded, []);
    const s = await readMonth(dir, "2026-09");
    assert.deepEqual(s.days[0].solar, [100, 1]);
  });

  test("leaves the day still being written alone", async () => {
    const dir = await fixture({
      "history-2026-09-10.jsonl": line("2026-09-10T02:00:00Z", 100),
    });
    const res = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });

    assert.equal(res.skippedToday, "2026-09-10");
    assert.deepEqual(res.folded, []);
    assert.ok((await readdir(dir)).includes("history-2026-09-10.jsonl"));
  });

  test("deletes a raw day only once it is summarised and past retention", async () => {
    const old = "2026-07-01";
    const recent = "2026-09-08";
    const dir = await fixture({
      [`history-${old}.jsonl`]: line("2026-07-01T00:10:00Z", 100),
      [`history-${recent}.jsonl`]: line("2026-09-08T00:10:00Z", 100),
    });
    const res = await summarize({ dataDir: dir, retentionDays: 30, timeZone: TOKYO, now });

    assert.deepEqual(res.deleted, [`history-${old}.jsonl`]);
    const left = await readdir(dir);
    assert.ok(!left.includes(`history-${old}.jsonl`));
    assert.ok(left.includes(`history-${recent}.jsonl`), "a day still inside the window stays");
    // The deleted day survives in the summary, which is what made it safe.
    assert.deepEqual((await readMonth(dir, "2026-07")).sources, [`history-${old}.jsonl`]);
  });

  test("a torn line is skipped without losing the rest of the day", async () => {
    const dir = await fixture({
      "history-2026-09-08.jsonl":
        line("2026-09-08T00:10:00Z", 100) +
        '{"timestamp":"2026-09-08T00:2\n' +
        line("2026-09-08T00:40:00Z", 200),
    });
    const res = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    assert.equal(res.folded[0].records, 2);
    assert.deepEqual((await readMonth(dir, "2026-09")).days[0].solar, [300, 2]);
  });

  test("writes the summary atomically, leaving no .tmp behind", async () => {
    const dir = await fixture({
      "history-2026-09-08.jsonl": line("2026-09-08T00:10:00Z", 100),
    });
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    const files = await readdir(join(dir, "summaries"));
    assert.deepEqual(files, ["2026-09.json"]);
  });

  test("folds the pre-rotation log, across the months it spans", async () => {
    const dir = await fixture({
      "history.jsonl": line("2026-08-31T10:00:00Z", 100) + line("2026-09-01T10:00:00Z", 200),
    });
    const res = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });

    assert.deepEqual(res.folded.map((f) => [f.source, f.months]), [
      ["history.jsonl", ["2026-08", "2026-09"]],
    ]);
    assert.deepEqual((await readMonth(dir, "2026-08")).days[0].solar, [100, 1]);
    assert.deepEqual((await readMonth(dir, "2026-09")).days[0].solar, [200, 1]);
    // Recorded in both, so neither month folds it a second time.
    assert.deepEqual((await readMonth(dir, "2026-08")).sources, ["history.jsonl"]);
    assert.deepEqual((await readMonth(dir, "2026-09")).sources, ["history.jsonl"]);
  });

  test("the day the loop switched files is folded from both, exactly once each", async () => {
    // The morning is in the old log and the evening in the new daily file.
    // Keyed by day the second would be skipped; keyed by source both land.
    const dir = await fixture({
      "history.jsonl": line("2026-09-08T01:00:00Z", 100),
      "history-2026-09-08.jsonl": line("2026-09-08T01:30:00Z", 300),
    });
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    const s = await readMonth(dir, "2026-09");

    assert.deepEqual(s.days.length, 1);
    assert.deepEqual(s.days[0].solar, [400, 2], "both halves of the day, counted once each");
    assert.deepEqual(s.sources, ["history-2026-09-08.jsonl", "history.jsonl"]);

    // And a second run adds nothing.
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    assert.deepEqual((await readMonth(dir, "2026-09")).days[0].solar, [400, 2]);
  });

  test("keeps the pre-rotation log until its last record is past retention", async () => {
    const dir = await fixture({
      "history.jsonl": line("2026-09-08T01:00:00Z", 100),
    });
    // Its mtime is now, so a 60 day window still wants it.
    const kept = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    assert.deepEqual(kept.deleted, []);
    assert.ok((await readdir(dir)).includes("history.jsonl"));

    // Far enough in the future, it is summarised and no longer needed raw.
    const later = await summarize({
      dataDir: dir,
      retentionDays: 60,
      timeZone: TOKYO,
      now: new Date(now.getTime() + 200 * 24 * 3600 * 1000),
    });
    assert.deepEqual(later.deleted, ["history.jsonl"]);
  });
});
