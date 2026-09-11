import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "./history";

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);
const DAY = 86_400_000;

type LineOpts = {
  offsetMs: number;
  solar?: number;
  devices?: { sn: string; name?: string; soc?: number; acIn?: number; target?: number; mode?: string }[];
};

const line = (o: LineOpts): string =>
  JSON.stringify({
    timestamp: new Date(T0 + o.offsetMs).toISOString(),
    totalSolarWatts: o.solar,
    devices: (o.devices ?? []).map((d) => ({
      sn: d.sn,
      name: d.name,
      batterySoc: d.soc,
      acInputWatts: d.acIn,
      targetWatts: d.target,
      mode: d.mode,
    })),
  }) + "\n";

/** Daily files are named for a local day; content decides what is read. */
const dayName = (n: number): string =>
  `history-${new Date(T0 + n * DAY).toISOString().slice(0, 10)}.jsonl`;

async function fixture(files: Record<string, string>, retentionDays = 60) {
  const dir = await mkdtemp(join(tmpdir(), "soltrk-hist-"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  const store = HistoryStore({ dataDir: dir, retentionDays });
  assert.equal(await store.refresh(), undefined);
  return { store, dir };
}

describe("HistoryStore", () => {
  test("averages watts within a bucket and reports the span", async () => {
    const { store } = await fixture({
      [dayName(0)]:
        line({ offsetMs: 0, solar: 100 }) +
        line({ offsetMs: 30_000, solar: 200 }) +
        line({ offsetMs: 60_000, solar: 900 }),
    });
    const s = store.query({ from: T0, to: T0 + 120_000, buckets: 2 });
    assert.equal(s.bucketMs, 60_000);
    assert.deepEqual(s.solar, [150, 900]);
    assert.deepEqual(store.span(), { from: T0, to: T0 + 60_000 });
  });

  test("leaves a bucket with no samples null rather than interpolating", async () => {
    const { store } = await fixture({
      [dayName(0)]: line({ offsetMs: 0, solar: 100 }) + line({ offsetMs: 120_000, solar: 300 }),
    });
    assert.deepEqual(store.query({ from: T0, to: T0 + 180_000, buckets: 3 }).solar, [100, null, 300]);
  });

  test("reads several days in time order", async () => {
    const { store } = await fixture({
      [dayName(1)]: line({ offsetMs: DAY, solar: 200 }),
      [dayName(0)]: line({ offsetMs: 0, solar: 100 }),
      [dayName(2)]: line({ offsetMs: 2 * DAY, solar: 300 }),
    });
    assert.equal(store.sampleCount(), 3);
    const s = store.query({ from: T0, to: T0 + 3 * DAY, buckets: 3 });
    assert.deepEqual(s.solar, [100, 200, 300]);
  });

  test("still reads the single file written before daily rotation", async () => {
    const { store } = await fixture({
      "history.jsonl": line({ offsetMs: 0, solar: 100 }),
      [dayName(1)]: line({ offsetMs: DAY, solar: 200 }),
    });
    assert.equal(store.sampleCount(), 2);
    assert.deepEqual(store.query({ from: T0, to: T0 + 2 * DAY, buckets: 2 }).solar, [100, 200]);
  });

  test("picks up the next day's file when the loop rolls over", async () => {
    const { store, dir } = await fixture({ [dayName(0)]: line({ offsetMs: 0, solar: 100 }) });
    assert.equal(store.sampleCount(), 1);

    await writeFile(join(dir, dayName(1)), line({ offsetMs: DAY, solar: 200 }));
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 2);
  });

  test("refresh only parses bytes appended since the last one", async () => {
    const { store, dir } = await fixture({ [dayName(0)]: line({ offsetMs: 0, solar: 10 }) });
    await appendFile(join(dir, dayName(0)), line({ offsetMs: 60_000, solar: 20 }));
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 2);

    // No growth: nothing is re-read, so the count cannot double.
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 2);
  });

  test("ignores a torn final line and picks it up once complete", async () => {
    const { store, dir } = await fixture({
      [dayName(0)]: line({ offsetMs: 0, solar: 10 }) + '{"timestamp":"2026-09-0',
    });
    assert.equal(store.sampleCount(), 1);

    await appendFile(join(dir, dayName(0)), '1T00:01:00.000Z","totalSolarWatts":20}\n');
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 2);
  });

  test("does not open days outside the retention window", async () => {
    const old = `history-${new Date(Date.now() - 400 * DAY).toISOString().slice(0, 10)}.jsonl`;
    const recent = `history-${new Date().toISOString().slice(0, 10)}.jsonl`;
    const { store } = await fixture(
      {
        [old]: line({ offsetMs: 0, solar: 999 }),
        [recent]: line({ offsetMs: 0, solar: 100 }),
      },
      60,
    );
    assert.ok(!store.files().includes(old), "an archived day is never opened");
    assert.ok(store.files().includes(recent));
  });

  test("survives a file being summarised away underneath it", async () => {
    const { store, dir } = await fixture({
      [dayName(0)]: line({ offsetMs: 0, solar: 100 }),
      [dayName(1)]: line({ offsetMs: DAY, solar: 200 }),
    });
    await unlink(join(dir, dayName(0)));
    assert.equal(await store.refresh(), undefined);
    // Samples already read stay; the deleted file simply stops being tracked.
    assert.equal(store.sampleCount(), 2);
    assert.ok(!store.files().includes(dayName(0)));
  });

  test("a device that appears mid-history does not shift earlier samples", async () => {
    const { store } = await fixture({
      [dayName(0)]:
        line({ offsetMs: 0, solar: 10, devices: [{ sn: "A", name: "冷蔵庫", soc: 50 }] }) +
        line({
          offsetMs: 60_000,
          solar: 20,
          devices: [
            { sn: "A", name: "冷蔵庫", soc: 51 },
            { sn: "B", name: "キッチン", soc: 90 },
          ],
        }),
    });
    const s = store.query({ from: T0, to: T0 + 120_000, buckets: 2 });
    assert.deepEqual(
      s.devices.map((d) => d.name),
      ["冷蔵庫", "キッチン"],
    );
    assert.deepEqual(s.devices[0].soc, [50, 51]);
    // B has no reading in the first bucket, and must not inherit A's.
    assert.deepEqual(s.devices[1].soc, [null, 90]);
  });

  test("reads records that predate batterySoc and mode", async () => {
    const legacy =
      JSON.stringify({
        timestamp: new Date(T0).toISOString(),
        totalSolarWatts: 50,
        devices: [{ sn: "A", name: "冷蔵庫", priority: 1, targetWatts: 100, acOn: false }],
      }) + "\n";
    const { store } = await fixture({
      [dayName(0)]:
        legacy +
        line({ offsetMs: 60_000, solar: 70, devices: [{ sn: "A", name: "冷蔵庫", soc: 42, mode: "charge" }] }),
    });
    const s = store.query({ from: T0, to: T0 + 120_000, buckets: 2 });
    assert.deepEqual(s.solar, [50, 70]);
    assert.deepEqual(s.devices[0].soc, [null, 42]);
    assert.deepEqual(s.devices[0].mode, [null, "charge"]);
  });

  test("picks the mode that held for most of the bucket", async () => {
    const dev = (mode: string) => [{ sn: "A", name: "事務室", mode }];
    const { store } = await fixture({
      [dayName(0)]:
        line({ offsetMs: 0, devices: dev("passthrough") }) +
        line({ offsetMs: 10_000, devices: dev("battery") }) +
        line({ offsetMs: 20_000, devices: dev("passthrough") }),
    });
    assert.deepEqual(store.query({ from: T0, to: T0 + 60_000, buckets: 1 }).devices[0].mode, [
      "passthrough",
    ]);
  });

  test("drops samples older than the retention window", async () => {
    const { store } = await fixture(
      {
        [dayName(0)]: line({ offsetMs: 0, solar: 10 }),
        [dayName(3)]: line({ offsetMs: 3 * DAY, solar: 20 }),
      },
      1,
    );
    assert.equal(store.sampleCount(), 1);
  });

  test("returns the error rather than throwing when the directory is missing", async () => {
    const store = HistoryStore({ dataDir: join(tmpdir(), "soltrk-nope-", String(Date.now())) });
    assert.ok((await store.refresh()) instanceof Error);
  });
});
