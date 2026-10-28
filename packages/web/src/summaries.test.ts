import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeriesBuilder } from "./buckets";
import { SummaryStore } from "./summaries";

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0); // 2026-08-01T00:00Z
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const month = (days: unknown[]) => JSON.stringify({ month: "2026-08", timeZone: "Asia/Tokyo", days });

/** One day standing for `n` cycles averaging `avg` watts of solar. */
const day = (offsetDays: number, avg: number, n: number) => ({
  t: T0 + offsetDays * DAY,
  solar: [avg * n, n],
});

async function fixture(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "soltrk-sums-"));
  await mkdir(join(dir, "summaries"), { recursive: true });
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, "summaries", name), body);
  const store = SummaryStore({ dataDir: dir });
  assert.equal(await store.refresh(), undefined);
  return { store, dir };
}

describe("SummaryStore", () => {
  test("spreads a day's total evenly across its 24 hours", async () => {
    const { store } = await fixture({ "2026-08.json": month([day(0, 120, 2880)]) });
    // One bucket per hour of the day: each should read back the day's own
    // average, not the whole day's energy crammed into a single hour.
    const b = SeriesBuilder({ from: T0, to: T0 + DAY, buckets: 24 });
    store.contribute(b, Number.POSITIVE_INFINITY);
    const s = b.finish();

    assert.equal(s.solar.length, 24);
    for (const v of s.solar) assert.equal(v, 120);
  });

  test("recovers the day's true mean when queried as a single bucket", async () => {
    const { store } = await fixture({ "2026-08.json": month([day(0, 120, 2880)]) });
    const b = SeriesBuilder({ from: T0, to: T0 + DAY, buckets: 1 });
    store.contribute(b, Number.POSITIVE_INFINITY);
    const s = b.finish();

    // All 24 virtual hours fold back into the one bucket; the sum/count
    // division by 24 and the re-aggregation by 24 cancel out exactly.
    assert.deepEqual(s.solar, [120]);
    assert.deepEqual(store.span(), { from: T0, to: T0 });
  });

  test("skips a day the raw log already covers", async () => {
    const { store } = await fixture({ "2026-08.json": month([day(0, 100, 2880), day(1, 900, 2880)]) });
    const b = SeriesBuilder({ from: T0, to: T0 + 2 * DAY, buckets: 2 });
    // The raw log starts at the second day, so only the first may be filled in.
    store.contribute(b, T0 + DAY);
    const s = b.finish();

    assert.deepEqual(s.solar, [100, null]);
  });

  test("a day outweighs a single raw cycle in the same bucket", async () => {
    const { store } = await fixture({ "2026-08.json": month([day(0, 100, 2880)]) });
    const b = SeriesBuilder({ from: T0, to: T0 + DAY, buckets: 1 });
    // One raw sample of 2000W lands in the same bucket as a day standing for
    // 2880 cycles at 100W. Averaging the two means would give 1050; weighting
    // by count gives the true mean of the 2881 cycles.
    b.addGlobal("solar", 0, 2000, 1);
    store.contribute(b, Number.POSITIVE_INFINITY);
    const s = b.finish();

    assert.ok(s.solar[0] !== null);
    assert.equal(Number(s.solar[0]).toFixed(2), "100.66");
  });

  test("contributes no per-device or per-panel detail - only the global totals", async () => {
    const { store } = await fixture({ "2026-08.json": month([day(0, 100, 2880)]) });
    const b = SeriesBuilder({ from: T0, to: T0 + DAY, buckets: 1 });
    store.contribute(b, Number.POSITIVE_INFINITY);
    const s = b.finish();

    assert.deepEqual(s.devices, []);
    assert.deepEqual(s.panels, []);
  });

  test("ignores a corrupt month without losing the others", async () => {
    const { store } = await fixture({
      "2026-08.json": month([day(0, 100, 2880)]),
      "2026-09.json": "{ this is not json",
    });
    assert.deepEqual(store.months(), ["2026-08"]);
    const b = SeriesBuilder({ from: T0, to: T0 + DAY, buckets: 1 });
    store.contribute(b, Number.POSITIVE_INFINITY);
    assert.deepEqual(b.finish().solar, [100]);
  });

  test("forgets a month whose file was removed", async () => {
    const { store, dir } = await fixture({ "2026-08.json": month([day(0, 100, 2880)]) });
    assert.deepEqual(store.months(), ["2026-08"]);
    await rm(join(dir, "summaries", "2026-08.json"));
    assert.equal(await store.refresh(), undefined);
    assert.deepEqual(store.months(), []);
    assert.equal(store.span(), undefined);
  });

  test("no summaries directory is a normal state, not an error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "soltrk-sums-"));
    const store = SummaryStore({ dataDir: dir });
    assert.equal(await store.refresh(), undefined);
    assert.deepEqual(store.months(), []);
  });
});
