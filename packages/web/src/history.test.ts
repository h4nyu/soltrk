import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryStore } from "./history";

const T0 = Date.UTC(2026, 8, 1, 0, 0, 0);

type LineOpts = {
  offsetMs: number;
  solar?: number;
  balance?: number;
  devices?: { sn: string; name?: string; soc?: number; acIn?: number; target?: number; mode?: string }[];
};

const line = (o: LineOpts): string =>
  JSON.stringify({
    timestamp: new Date(T0 + o.offsetMs).toISOString(),
    totalSolarWatts: o.solar,
    balanceWatts: o.balance,
    devices: (o.devices ?? []).map((d) => ({
      sn: d.sn,
      name: d.name,
      batterySoc: d.soc,
      acInputWatts: d.acIn,
      targetWatts: d.target,
      mode: d.mode,
    })),
  }) + "\n";

async function storeWith(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "soltrk-history-"));
  const path = join(dir, "history.jsonl");
  await writeFile(path, contents);
  const store = HistoryStore({ path });
  const err = await store.refresh();
  assert.equal(err, undefined);
  return { store, path };
}

describe("HistoryStore", () => {
  test("averages watts within a bucket and reports the span", async () => {
    const { store } = await storeWith(
      line({ offsetMs: 0, solar: 100 }) +
        line({ offsetMs: 30_000, solar: 200 }) +
        line({ offsetMs: 60_000, solar: 900 }),
    );

    // Two 60s buckets over a 120s window: the first holds the 100W and 200W
    // samples, the second holds the 900W one.
    const s = store.query({ from: T0, to: T0 + 120_000, buckets: 2 });
    assert.equal(s.bucketMs, 60_000);
    assert.deepEqual(s.solar, [150, 900]);
    assert.deepEqual(store.span(), { from: T0, to: T0 + 60_000 });
  });

  test("leaves a bucket with no samples null rather than interpolating", async () => {
    const { store } = await storeWith(line({ offsetMs: 0, solar: 100 }) + line({ offsetMs: 120_000, solar: 300 }));
    const s = store.query({ from: T0, to: T0 + 180_000, buckets: 3 });
    assert.deepEqual(s.solar, [100, null, 300]);
  });

  test("reads records that predate batterySoc and mode", async () => {
    // The oldest lines in the real file carry a `priority` and none of the
    // fields the dashboard charts; they must not poison the series.
    const legacy =
      JSON.stringify({
        timestamp: new Date(T0).toISOString(),
        totalSolarWatts: 50,
        devices: [{ sn: "A", name: "冷蔵庫", priority: 1, targetWatts: 100, acOn: false }],
      }) + "\n";
    const { store } = await storeWith(
      legacy + line({ offsetMs: 60_000, solar: 70, devices: [{ sn: "A", name: "冷蔵庫", soc: 42, mode: "charge" }] }),
    );

    const s = store.query({ from: T0, to: T0 + 120_000, buckets: 2 });
    assert.deepEqual(s.solar, [50, 70]);
    assert.equal(s.devices.length, 1);
    assert.deepEqual(s.devices[0].soc, [null, 42]);
    assert.deepEqual(s.devices[0].mode, [null, "charge"]);
  });

  test("picks the mode that held for most of the bucket", async () => {
    const dev = (mode: string) => [{ sn: "A", name: "事務室", mode }];
    const { store } = await storeWith(
      line({ offsetMs: 0, devices: dev("passthrough") }) +
        line({ offsetMs: 10_000, devices: dev("battery") }) +
        line({ offsetMs: 20_000, devices: dev("passthrough") }),
    );
    const s = store.query({ from: T0, to: T0 + 60_000, buckets: 1 });
    assert.deepEqual(s.devices[0].mode, ["passthrough"]);
  });

  test("ignores a torn final line and picks it up once complete", async () => {
    // pino appends; a read landing mid-write sees a partial JSON object.
    const { store, path } = await storeWith(line({ offsetMs: 0, solar: 10 }) + '{"timestamp":"2026-09-0');
    assert.equal(store.sampleCount(), 1);

    await appendFile(path, '1T00:01:00.000Z","totalSolarWatts":20}\n');
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 2);
    assert.deepEqual(store.query({ from: T0, to: T0 + 120_000, buckets: 2 }).solar, [10, 20]);
  });

  test("refresh only parses bytes appended since the last one", async () => {
    const { store, path } = await storeWith(line({ offsetMs: 0, solar: 10 }));
    assert.equal(store.sampleCount(), 1);

    await appendFile(path, line({ offsetMs: 60_000, solar: 20 }));
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 2);

    // No growth: nothing is re-read, so the count cannot double.
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 2);
  });

  test("reloads from the start when the file was pruned by hand", async () => {
    const first = line({ offsetMs: 0, solar: 10 });
    const { store, path } = await storeWith(first + line({ offsetMs: 60_000, solar: 20 }));
    assert.equal(store.sampleCount(), 2);

    await truncate(path, first.length);
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 1);
  });

  test("drops samples older than the retention window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "soltrk-history-"));
    const path = join(dir, "history.jsonl");
    await writeFile(
      path,
      line({ offsetMs: 0, solar: 10 }) + line({ offsetMs: 3 * 86_400_000, solar: 20 }),
    );
    const store = HistoryStore({ path, retentionDays: 1 });
    assert.equal(await store.refresh(), undefined);
    assert.equal(store.sampleCount(), 1);
  });

  test("returns the error rather than throwing when the file is missing", async () => {
    const store = HistoryStore({ path: join(tmpdir(), "soltrk-does-not-exist", "history.jsonl") });
    const err = await store.refresh();
    assert.ok(err instanceof Error);
  });
});
