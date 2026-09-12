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

const line = (iso: string, solar: number, soc: number, mode: string): string =>
  JSON.stringify({
    timestamp: iso,
    totalSolarWatts: solar,
    balanceWatts: -10,
    devices: [{ sn: "A", name: "冷蔵庫", batterySoc: soc, acInputWatts: 40, targetWatts: 30, mode }],
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

  test("folds a completed day into its month as sums and counts", async () => {
    const dir = await fixture({
      "history-2026-09-08.jsonl":
        line("2026-09-08T00:10:00Z", 100, 50, "charge") +
        line("2026-09-08T00:40:00Z", 200, 52, "charge") +
        line("2026-09-08T01:10:00Z", 300, 54, "passthrough"),
    });
    const res = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    assert.deepEqual(
      res.folded.map((f) => [f.source, f.months, f.records]),
      [["history-2026-09-08.jsonl", ["2026-09"], 3]],
    );

    const s = await readMonth(dir, "2026-09");
    assert.equal(s.hours.length, 2);
    // Sum and count, not a mean - so the hour can be re-averaged with others.
    assert.deepEqual(s.hours[0].solar, [300, 2]);
    assert.deepEqual(s.hours[1].solar, [300, 1]);
    assert.deepEqual(s.hours[0].dev[0].m, { charge: 2 });
    assert.deepEqual(s.sources, ["history-2026-09-08.jsonl"]);
    assert.equal(s.timeZone, TOKYO);
  });

  test("running twice folds nothing twice", async () => {
    const dir = await fixture({
      "history-2026-09-08.jsonl": line("2026-09-08T00:10:00Z", 100, 50, "charge"),
    });
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    const second = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });

    assert.deepEqual(second.folded, []);
    const s = await readMonth(dir, "2026-09");
    assert.deepEqual(s.hours[0].solar, [100, 1]);
  });

  test("leaves the day still being written alone", async () => {
    const dir = await fixture({
      "history-2026-09-10.jsonl": line("2026-09-10T02:00:00Z", 100, 50, "charge"),
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
      [`history-${old}.jsonl`]: line("2026-07-01T00:10:00Z", 100, 50, "charge"),
      [`history-${recent}.jsonl`]: line("2026-09-08T00:10:00Z", 100, 50, "charge"),
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
        line("2026-09-08T00:10:00Z", 100, 50, "charge") +
        '{"timestamp":"2026-09-08T00:2\n' +
        line("2026-09-08T00:40:00Z", 200, 52, "charge"),
    });
    const res = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    assert.equal(res.folded[0].records, 2);
    assert.deepEqual((await readMonth(dir, "2026-09")).hours[0].solar, [300, 2]);
  });

  test("writes the summary atomically, leaving no .tmp behind", async () => {
    const dir = await fixture({
      "history-2026-09-08.jsonl": line("2026-09-08T00:10:00Z", 100, 50, "charge"),
    });
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    const files = await readdir(join(dir, "summaries"));
    assert.deepEqual(files, ["2026-09.json"]);
  });
  test("folds the pre-rotation log, across the months it spans", async () => {
    const dir = await fixture({
      "history.jsonl":
        line("2026-08-31T10:00:00Z", 100, 50, "charge") + line("2026-09-01T10:00:00Z", 200, 52, "charge"),
    });
    const res = await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });

    assert.deepEqual(res.folded.map((f) => [f.source, f.months]), [
      ["history.jsonl", ["2026-08", "2026-09"]],
    ]);
    assert.deepEqual((await readMonth(dir, "2026-08")).hours[0].solar, [100, 1]);
    assert.deepEqual((await readMonth(dir, "2026-09")).hours[0].solar, [200, 1]);
    // Recorded in both, so neither month folds it a second time.
    assert.deepEqual((await readMonth(dir, "2026-08")).sources, ["history.jsonl"]);
    assert.deepEqual((await readMonth(dir, "2026-09")).sources, ["history.jsonl"]);
  });

  test("the day the loop switched files is folded from both, exactly once each", async () => {
    // The morning is in the old log and the evening in the new daily file.
    // Keyed by day the second would be skipped; keyed by source both land.
    const dir = await fixture({
      "history.jsonl": line("2026-09-08T01:00:00Z", 100, 50, "charge"),
      "history-2026-09-08.jsonl": line("2026-09-08T01:30:00Z", 300, 52, "charge"),
    });
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    const s = await readMonth(dir, "2026-09");

    assert.deepEqual(s.hours.length, 1);
    assert.deepEqual(s.hours[0].solar, [400, 2], "both halves of the day, counted once each");
    assert.deepEqual(s.sources, ["history-2026-09-08.jsonl", "history.jsonl"]);

    // And a second run adds nothing.
    await summarize({ dataDir: dir, retentionDays: 60, timeZone: TOKYO, now });
    assert.deepEqual((await readMonth(dir, "2026-09")).hours[0].solar, [400, 2]);
  });

  test("keeps the pre-rotation log until its last record is past retention", async () => {
    const dir = await fixture({
      "history.jsonl": line("2026-09-08T01:00:00Z", 100, 50, "charge"),
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
