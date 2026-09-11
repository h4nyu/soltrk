import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeriesBuilder } from "./buckets";
import { SummaryStore } from "./summaries";

const T0 = Date.UTC(2026, 7, 1, 0, 0, 0); // 2026-08-01T00:00Z
const HOUR = 3_600_000;

const month = (hours: unknown[], devices = [{ sn: "A", name: "冷蔵庫" }]) =>
  JSON.stringify({ month: "2026-08", timeZone: "Asia/Tokyo", days: [], devices, hours });

/** One hour standing for `n` cycles averaging `avg` watts of solar. */
const hour = (offsetH: number, avg: number, n: number, dev?: unknown[]) => ({
  t: T0 + offsetH * HOUR,
  solar: [avg * n, n],
  dev: dev ?? [{ soc: [50 * n, n], m: { passthrough: n } }],
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
  test("contributes an hour as the mean of the cycles behind it", async () => {
    const { store } = await fixture({ "2026-08.json": month([hour(0, 120, 120)]) });
    const b = SeriesBuilder({ from: T0, to: T0 + HOUR, buckets: 1 });
    store.contribute(b, Number.POSITIVE_INFINITY);
    const s = b.finish();

    assert.deepEqual(s.solar, [120]);
    assert.deepEqual(s.devices[0].soc, [50]);
    assert.deepEqual(s.devices[0].mode, ["passthrough"]);
    assert.deepEqual(store.span(), { from: T0, to: T0 });
  });

  test("skips hours the raw log already covers", async () => {
    const { store } = await fixture({ "2026-08.json": month([hour(0, 100, 120), hour(1, 900, 120)]) });
    const b = SeriesBuilder({ from: T0, to: T0 + 2 * HOUR, buckets: 2 });
    // The raw log starts at the second hour, so only the first may be filled in.
    store.contribute(b, T0 + HOUR);
    const s = b.finish();

    assert.deepEqual(s.solar, [100, null]);
  });

  test("an hour outweighs a single raw cycle in the same bucket", async () => {
    const { store } = await fixture({ "2026-08.json": month([hour(0, 100, 120)]) });
    const b = SeriesBuilder({ from: T0, to: T0 + HOUR, buckets: 1 });
    // One raw sample of 200W lands in the same bucket as an hour standing for
    // 120 cycles at 100W. Averaging the two means would give 150; weighting by
    // count gives 100.8, which is the true mean of the 121 cycles.
    b.addGlobal("solar", 0, 200, 1);
    store.contribute(b, Number.POSITIVE_INFINITY);
    const s = b.finish();

    assert.ok(s.solar[0] !== null);
    assert.equal(Number(s.solar[0]).toFixed(2), "100.83");
  });

  test("ignores a corrupt month without losing the others", async () => {
    const { store } = await fixture({
      "2026-08.json": month([hour(0, 100, 120)]),
      "2026-09.json": "{ this is not json",
    });
    assert.deepEqual(store.months(), ["2026-08"]);
    const b = SeriesBuilder({ from: T0, to: T0 + HOUR, buckets: 1 });
    store.contribute(b, Number.POSITIVE_INFINITY);
    assert.deepEqual(b.finish().solar, [100]);
  });

  test("forgets a month whose file was removed", async () => {
    const { store, dir } = await fixture({ "2026-08.json": month([hour(0, 100, 120)]) });
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

  test("a device slot with no matching name is skipped rather than misattributed", async () => {
    // `dev` is positional against `devices`; a file listing one device but two
    // slots must not invent a second unit.
    const { store } = await fixture({
      "2026-08.json": month([hour(0, 100, 10, [{ soc: [500, 10] }, { soc: [900, 10] }])]),
    });
    const b = SeriesBuilder({ from: T0, to: T0 + HOUR, buckets: 1 });
    store.contribute(b, Number.POSITIVE_INFINITY);
    const s = b.finish();
    assert.equal(s.devices.length, 1);
    assert.deepEqual(s.devices[0].soc, [50]);
  });
});
