import { open, stat } from "node:fs/promises";

/**
 * The shape of one line in data/history.jsonl.
 *
 * Every field past `timestamp` is optional on purpose. This is an append-only
 * log whose schema has already drifted once - the oldest records carry a
 * `priority` number and no `batterySoc`, `mode` or `acOutputWatts`, because
 * those were added to the control loop later. A viewer of such a log must
 * read what is there rather than what the current writer happens to emit,
 * which is also why this package deliberately does not import the live
 * `StateSnapshot` type from @soltrk/core: sharing it would make every future
 * change to the loop's snapshot silently reinterpret months of old records.
 */
type DeviceRecord = {
  sn?: string;
  name?: string;
  batterySoc?: number;
  acInputWatts?: number;
  acOutputWatts?: number;
  targetWatts?: number;
  acOn?: boolean;
  mode?: string;
};

type CycleRecord = {
  timestamp?: string;
  totalSolarWatts?: number;
  totalAcInputWatts?: number;
  totalAcOutputWatts?: number;
  balanceWatts?: number;
  devices?: DeviceRecord[];
};

/** One parsed cycle, flattened. Device values are indexed by device order. */
type Sample = {
  t: number;
  solar?: number;
  acIn?: number;
  acOut?: number;
  balance?: number;
  soc: (number | undefined)[];
  devAcIn: (number | undefined)[];
  devAcOut: (number | undefined)[];
  target: (number | undefined)[];
  mode: (string | undefined)[];
};

export type DeviceMeta = { sn: string; name: string };

export type Series = {
  from: number;
  to: number;
  bucketMs: number;
  /** Bucket start times, epoch ms. uPlot wants seconds, the client converts. */
  t: number[];
  solar: (number | null)[];
  acIn: (number | null)[];
  acOut: (number | null)[];
  balance: (number | null)[];
  devices: {
    sn: string;
    name: string;
    soc: (number | null)[];
    acIn: (number | null)[];
    acOut: (number | null)[];
    target: (number | null)[];
    /** Dominant AC mode in the bucket: charge | passthrough | battery. */
    mode: (string | null)[];
  }[];
};

const DAY_MS = 86_400_000;

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Most frequent value in the bucket - a mode that only blipped shouldn't win. */
const dominant = (xs: string[]): string | null => {
  if (xs.length === 0) return null;
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | null = null;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN) [best, bestN] = [k, n];
  return best;
};

/**
 * Reads data/history.jsonl incrementally and answers bucketed range queries.
 *
 * The file is append-only and already 21MB after two weeks, so it is read once
 * and then tailed: each refresh stats the file and parses only the bytes added
 * since the last one. A file that shrank was pruned by hand, so it is reloaded
 * from the start. Samples older than `retentionDays` are dropped, which bounds
 * memory on the Pi - the UI never asks for more than a few weeks anyway.
 */
export const HistoryStore = (props: {
  path: string;
  retentionDays?: number;
}) => {
  const retentionMs = (props.retentionDays ?? 30) * DAY_MS;
  let samples: Sample[] = [];
  let devices: DeviceMeta[] = [];
  let offset = 0;
  let partial = "";

  const deviceIndex = (sn: string, name: string | undefined): number => {
    const existing = devices.findIndex((d) => d.sn === sn);
    if (existing >= 0) {
      if (name && devices[existing].name !== name) devices[existing].name = name;
      return existing;
    }
    devices.push({ sn, name: name ?? sn });
    return devices.length - 1;
  };

  const ingest = (line: string): void => {
    if (line.length === 0) return;
    let rec: CycleRecord;
    try {
      rec = JSON.parse(line) as CycleRecord;
    } catch {
      return; // a torn last line while the loop was mid-write; it reappears complete next refresh
    }
    const t = Date.parse(rec.timestamp ?? "");
    if (Number.isNaN(t)) return;
    const sample: Sample = {
      t,
      solar: rec.totalSolarWatts,
      acIn: rec.totalAcInputWatts,
      acOut: rec.totalAcOutputWatts,
      balance: rec.balanceWatts,
      soc: [],
      devAcIn: [],
      devAcOut: [],
      target: [],
      mode: [],
    };
    for (const d of rec.devices ?? []) {
      if (!d.sn) continue;
      const i = deviceIndex(d.sn, d.name);
      sample.soc[i] = d.batterySoc;
      sample.devAcIn[i] = d.acInputWatts;
      sample.devAcOut[i] = d.acOutputWatts;
      sample.target[i] = d.targetWatts;
      sample.mode[i] = d.mode;
    }
    samples.push(sample);
  };

  const prune = (): void => {
    if (samples.length === 0) return;
    const cutoff = samples[samples.length - 1].t - retentionMs;
    if (samples[0].t >= cutoff) return;
    samples = samples.filter((s) => s.t >= cutoff);
  };

  const refresh = async (): Promise<undefined | Error> => {
    let size: number;
    try {
      size = (await stat(props.path)).size;
    } catch (err) {
      return err as Error;
    }
    if (size < offset) {
      // Pruned or rotated by hand - start over rather than read garbage.
      samples = [];
      devices = [];
      offset = 0;
      partial = "";
    }
    if (size === offset) return undefined;

    const handle = await open(props.path, "r");
    try {
      const length = size - offset;
      const buf = Buffer.allocUnsafe(length);
      await handle.read(buf, 0, length, offset);
      offset = size;
      const text = partial + buf.toString("utf8");
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) ingest(line);
    } finally {
      await handle.close();
    }
    prune();
    return undefined;
  };

  const query = (opts: { from: number; to: number; buckets: number }): Series => {
    const span = Math.max(1, opts.to - opts.from);
    const bucketMs = Math.max(1000, Math.ceil(span / Math.max(1, opts.buckets)));
    const count = Math.ceil(span / bucketMs);

    const t: number[] = [];
    for (let i = 0; i < count; i += 1) t.push(opts.from + i * bucketMs);

    const empty = (): number[][] => Array.from({ length: count }, () => []);
    const solarB = empty();
    const acInB = empty();
    const acOutB = empty();
    const balanceB = empty();
    const devB = devices.map(() => ({
      soc: empty(),
      acIn: empty(),
      acOut: empty(),
      target: empty(),
      mode: Array.from({ length: count }, () => [] as string[]),
    }));

    for (const s of samples) {
      if (s.t < opts.from || s.t >= opts.to) continue;
      const b = Math.min(count - 1, Math.floor((s.t - opts.from) / bucketMs));
      if (s.solar !== undefined) solarB[b].push(s.solar);
      if (s.acIn !== undefined) acInB[b].push(s.acIn);
      if (s.acOut !== undefined) acOutB[b].push(s.acOut);
      if (s.balance !== undefined) balanceB[b].push(s.balance);
      for (let i = 0; i < devices.length; i += 1) {
        const d = devB[i];
        if (s.soc[i] !== undefined) d.soc[b].push(s.soc[i] as number);
        if (s.devAcIn[i] !== undefined) d.acIn[b].push(s.devAcIn[i] as number);
        if (s.devAcOut[i] !== undefined) d.acOut[b].push(s.devAcOut[i] as number);
        if (s.target[i] !== undefined) d.target[b].push(s.target[i] as number);
        if (s.mode[i] !== undefined) d.mode[b].push(s.mode[i] as string);
      }
    }

    return {
      from: opts.from,
      to: opts.to,
      bucketMs,
      t,
      solar: solarB.map(mean),
      acIn: acInB.map(mean),
      acOut: acOutB.map(mean),
      balance: balanceB.map(mean),
      devices: devices.map((d, i) => ({
        sn: d.sn,
        name: d.name,
        soc: devB[i].soc.map(mean),
        acIn: devB[i].acIn.map(mean),
        acOut: devB[i].acOut.map(mean),
        target: devB[i].target.map(mean),
        mode: devB[i].mode.map(dominant),
      })),
    };
  };

  return {
    refresh,
    query,
    devices: (): DeviceMeta[] => devices.map((d) => ({ ...d })),
    sampleCount: (): number => samples.length,
    span: (): { from: number; to: number } | undefined =>
      samples.length === 0
        ? undefined
        : { from: samples[0].t, to: samples[samples.length - 1].t },
  };
};

export type HistoryStore = ReturnType<typeof HistoryStore>;
