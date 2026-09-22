import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Series } from "./buckets";
import { energyOf, periodStarts } from "./energy";

const HOUR = 3_600_000;

/** A range of whole-hour buckets, so watts and watt-hours line up 1:1. */
const series = (solar: (number | null)[], deviceAcIn: (number | null)[][] = []): Series => ({
  from: 0,
  to: solar.length * HOUR,
  bucketMs: HOUR,
  t: solar.map((_, i) => i * HOUR),
  solar,
  acIn: solar.map(() => null),
  acOut: solar.map(() => null),
  balance: solar.map(() => null),
  devices: deviceAcIn.map((acIn, i) => ({
    sn: `S${i}`,
    name: `dev${i}`,
    soc: solar.map(() => null),
    acIn,
    acOut: solar.map(() => null),
    target: solar.map(() => null),
    mode: solar.map(() => null),
  })),
  panels: [],
});

describe("energyOf", () => {
  test("turns watts held for an hour into watt-hours", () => {
    const e = energyOf(series([1000, 500]), { houseStandbyWatts: 5000, yenPerKwh: 30 });
    assert.equal(e.generatedKwh, 1.5);
    assert.equal(e.usedKwh, 1.5, "the house can absorb all of it here");
    assert.equal(e.yen, 45);
  });

  test("prices only what the house could take, not what was generated", () => {
    // 1000W generated against a house drawing 100W and nothing charging: 900W
    // is given away, and with no export payment it is worth nothing.
    const e = energyOf(series([1000]), { houseStandbyWatts: 100, yenPerKwh: 30 });
    assert.equal(e.generatedKwh, 1);
    assert.equal(e.usedKwh, 0.1);
    assert.equal(e.yen, 3);
  });

  test("counts what the units are drawing as consumption", () => {
    // The same 1000W, but two units are pulling 400W between them.
    const e = energyOf(series([1000], [[300], [100]]), { houseStandbyWatts: 100, yenPerKwh: 30 });
    assert.equal(e.usedKwh, 0.5);
  });

  test("scales with the bucket width rather than assuming hours", () => {
    const s = series([1000]);
    const quarter: Series = { ...s, bucketMs: HOUR / 4 };
    const e = energyOf(quarter, { houseStandbyWatts: 5000, yenPerKwh: 30 });
    assert.equal(e.generatedKwh, 0.25);
  });

  test("a bucket with no reading contributes nothing rather than being filled in", () => {
    // An outage must read as no generation, not as a continuation of the last
    // value - otherwise a dead logger would look like free electricity.
    const e = energyOf(series([1000, null, 1000]), { houseStandbyWatts: 5000, yenPerKwh: 30 });
    assert.equal(e.generatedKwh, 2);
  });

  test("a device with no reading in a bucket does not drag consumption down", () => {
    const e = energyOf(series([1000], [[null], [200]]), { houseStandbyWatts: 100, yenPerKwh: 30 });
    assert.equal(e.usedKwh, 0.3);
  });
});

describe("periodStarts", () => {
  test("returns local midnight and the first of the local month", () => {
    // TZ is what makes these local; the container is given one.
    const now = new Date(2026, 8, 13, 14, 30, 0); // 13 Sep, local
    const { day, month } = periodStarts(now);
    assert.equal(new Date(day).getHours(), 0);
    assert.equal(new Date(day).getDate(), 13);
    assert.equal(new Date(month).getDate(), 1);
    assert.equal(new Date(month).getMonth(), 8);
    assert.ok(month <= day);
  });
});
