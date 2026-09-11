import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DeviceMeta, MODES, Series, SeriesBuilder } from "./buckets";

/**
 * The shape of one line in a history log.
 *
 * Every field past `timestamp` is optional on purpose. This is an append-only
 * log whose schema has already drifted once - the oldest records carry a
 * `priority` and no `batterySoc`, `mode` or `acOutputWatts`, because those were
 * added to the control loop later. A viewer of such a log must read what is
 * there rather than what the current writer happens to emit, which is also why
 * this package deliberately does not import the live `StateSnapshot` type from
 * @soltrk/core: sharing it would make every future change to the loop's
 * snapshot silently reinterpret months of old records.
 */
type DeviceRecord = {
  sn?: string;
  name?: string;
  batterySoc?: number;
  acInputWatts?: number;
  acOutputWatts?: number;
  targetWatts?: number;
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

export type { DeviceMeta, Series } from "./buckets";

const DAY_MS = 86_400_000;

/** Modes are held as indexes into the shared MODES list, beside the numbers. */
const MODE_UNKNOWN = -1;

/** Files the control loop writes, one per local calendar day. */
const DAILY_RE = /^history-(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** The single growing file used before daily rotation; read if still present. */
const LEGACY_NAME = "history.jsonl";

/**
 * Columns rather than one object per cycle.
 *
 * A cycle held as an object plus five small per-device arrays measured about
 * 3KB on the Pi, which put the dashboard at 95MB for two weeks of history and
 * on course for roughly 250MB once the retention window filled - on a machine
 * with 905MB total. The same cycle as twenty numbers across parallel arrays is
 * about 160 bytes. Missing values are NaN, which is why every read goes
 * through `orNull`.
 */
type Columns = {
  t: number[];
  solar: number[];
  acIn: number[];
  acOut: number[];
  balance: number[];
  dev: { soc: number[]; acIn: number[]; acOut: number[]; target: number[]; mode: number[] }[];
};

const newColumns = (): Columns => ({ t: [], solar: [], acIn: [], acOut: [], balance: [], dev: [] });

const num = (v: number | undefined): number => (v === undefined ? NaN : v);

type FileState = { name: string; offset: number; partial: string; day: string | undefined };

/**
 * Reads the control loop's history logs and answers bucketed range queries.
 *
 * The loop writes one file per local day and never touches a completed one
 * again, so only the newest file is tailed: each refresh stats what it knows,
 * reads just the bytes appended since last time, and picks up files that have
 * appeared. Files whose day is outside the retention window are not opened at
 * all, which is what keeps startup bounded as the archive grows - and is why
 * `soltrk summarize` may delete them without this ever noticing.
 */
export const HistoryStore = (props: { dataDir: string; retentionDays?: number }) => {
  const retentionMs = (props.retentionDays ?? 60) * DAY_MS;
  let cols = newColumns();
  let devices: DeviceMeta[] = [];
  const files = new Map<string, FileState>();

  const deviceIndex = (sn: string, name: string | undefined): number => {
    const existing = devices.findIndex((d) => d.sn === sn);
    if (existing >= 0) {
      if (name && devices[existing].name !== name) devices[existing].name = name;
      return existing;
    }
    devices.push({ sn, name: name ?? sn });
    cols.dev.push({ soc: [], acIn: [], acOut: [], target: [], mode: [] });
    // Back-fill the new device's columns so every column stays the same length
    // as `t`; a unit added mid-history must not shift earlier samples.
    const d = cols.dev[cols.dev.length - 1];
    for (let i = 0; i < cols.t.length; i += 1) {
      d.soc.push(NaN);
      d.acIn.push(NaN);
      d.acOut.push(NaN);
      d.target.push(NaN);
      d.mode.push(MODE_UNKNOWN);
    }
    return devices.length - 1;
  };

  const ingest = (line: string): void => {
    if (line.length === 0) return;
    let rec: CycleRecord;
    try {
      rec = JSON.parse(line) as CycleRecord;
    } catch {
      return; // a torn last line while the loop was mid-write; complete next refresh
    }
    const t = Date.parse(rec.timestamp ?? "");
    if (Number.isNaN(t)) return;

    cols.t.push(t);
    cols.solar.push(num(rec.totalSolarWatts));
    cols.acIn.push(num(rec.totalAcInputWatts));
    cols.acOut.push(num(rec.totalAcOutputWatts));
    cols.balance.push(num(rec.balanceWatts));
    const row = cols.t.length - 1;
    for (const d of cols.dev) {
      d.soc.push(NaN);
      d.acIn.push(NaN);
      d.acOut.push(NaN);
      d.target.push(NaN);
      d.mode.push(MODE_UNKNOWN);
    }
    for (const d of rec.devices ?? []) {
      if (!d.sn) continue;
      const i = deviceIndex(d.sn, d.name);
      const c = cols.dev[i];
      c.soc[row] = num(d.batterySoc);
      c.acIn[row] = num(d.acInputWatts);
      c.acOut[row] = num(d.acOutputWatts);
      c.target[row] = num(d.targetWatts);
      c.mode[row] = d.mode ? MODES.indexOf(d.mode as (typeof MODES)[number]) : MODE_UNKNOWN;
    }
  };

  const prune = (): void => {
    if (cols.t.length === 0) return;
    const cutoff = cols.t[cols.t.length - 1] - retentionMs;
    if (cols.t[0] >= cutoff) return;
    let first = 0;
    while (first < cols.t.length && cols.t[first] < cutoff) first += 1;
    if (first === 0) return;
    cols.t = cols.t.slice(first);
    cols.solar = cols.solar.slice(first);
    cols.acIn = cols.acIn.slice(first);
    cols.acOut = cols.acOut.slice(first);
    cols.balance = cols.balance.slice(first);
    for (const d of cols.dev) {
      d.soc = d.soc.slice(first);
      d.acIn = d.acIn.slice(first);
      d.acOut = d.acOut.slice(first);
      d.target = d.target.slice(first);
      d.mode = d.mode.slice(first);
    }
  };

  /**
   * Files worth opening: the legacy one, plus days inside the window.
   *
   * The window is measured back from the newest day present, not from the
   * clock. Measuring from the clock looks equivalent and is not: if the loop
   * has been stopped for longer than the retention window, every file falls
   * outside it and the dashboard goes blank exactly when someone is trying to
   * find out what happened. It also keeps this in step with `prune`, which is
   * likewise relative to the newest sample.
   */
  const relevantFiles = async (): Promise<{ name: string; day: string | undefined }[]> => {
    const entries = await readdir(props.dataDir);
    const days = entries.map((n) => DAILY_RE.exec(n)?.[1]).filter((d): d is string => d !== undefined);
    const newest = days.sort().at(-1);
    // A day of slack: the filename names a local day while this arithmetic is
    // in UTC, and keeping a file that turns out to be unwanted is much cheaper
    // than dropping one that still holds samples on display.
    const cutoffDay =
      newest === undefined
        ? undefined
        : new Date(Date.parse(`${newest}T00:00:00Z`) - retentionMs - DAY_MS).toISOString().slice(0, 10);

    const out: { name: string; day: string | undefined }[] = [];
    for (const name of entries) {
      if (name === LEGACY_NAME) out.push({ name, day: undefined });
      const m = DAILY_RE.exec(name);
      if (m && (cutoffDay === undefined || m[1] >= cutoffDay)) out.push({ name, day: m[1] });
    }
    // Legacy first, then days in order, so samples arrive sorted by time.
    return out.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""));
  };

  const readNewBytes = async (f: FileState): Promise<void> => {
    const path = join(props.dataDir, f.name);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      files.delete(f.name); // summarised and deleted underneath us; fine
      return;
    }
    if (size < f.offset) {
      // Truncated or replaced by hand - the samples already read stay, and the
      // file is picked up again from the start on the next pass.
      f.offset = 0;
      f.partial = "";
    }
    if (size === f.offset) return;
    const handle = await open(path, "r");
    try {
      const length = size - f.offset;
      const buf = Buffer.allocUnsafe(length);
      await handle.read(buf, 0, length, f.offset);
      f.offset = size;
      const lines = (f.partial + buf.toString("utf8")).split("\n");
      f.partial = lines.pop() ?? "";
      for (const line of lines) ingest(line);
    } finally {
      await handle.close();
    }
  };

  const refresh = async (): Promise<undefined | Error> => {
    let found: { name: string; day: string | undefined }[];
    try {
      found = await relevantFiles();
    } catch (err) {
      return err as Error;
    }
    const present = new Set(found.map((f) => f.name));
    for (const name of files.keys()) if (!present.has(name)) files.delete(name);
    for (const f of found) {
      let state = files.get(f.name);
      if (state === undefined) {
        state = { name: f.name, offset: 0, partial: "", day: f.day };
        files.set(f.name, state);
      }
      await readNewBytes(state);
    }
    prune();
    return undefined;
  };

  /**
   * Adds every raw sample in range to a builder that may also be receiving
   * hourly aggregates from the monthly summaries. Each sample counts as one.
   */
  const contribute = (b: SeriesBuilder): void => {
    for (const d of devices) b.touchDevice(d);
    for (let r = 0; r < cols.t.length; r += 1) {
      const i = b.indexOf(cols.t[r]);
      if (i < 0) continue;
      for (const k of ["solar", "acIn", "acOut", "balance"] as const) {
        const v = cols[k][r];
        if (!Number.isNaN(v)) b.addGlobal(k, i, v, 1);
      }
      for (let dv = 0; dv < cols.dev.length; dv += 1) {
        const c = cols.dev[dv];
        const meta = devices[dv];
        for (const k of ["soc", "acIn", "acOut", "target"] as const) {
          const v = c[k][r];
          if (!Number.isNaN(v)) b.addDevice(meta, k, i, v, 1);
        }
        const m = c.mode[r];
        if (m >= 0) b.addMode(meta, MODES[m], i, 1);
      }
    }
  };

  const query = (opts: { from: number; to: number; buckets: number }): Series => {
    const b = SeriesBuilder(opts);
    contribute(b);
    return b.finish();
  };

  return {
    refresh,
    query,
    contribute,
    devices: (): DeviceMeta[] => devices.map((d) => ({ ...d })),
    sampleCount: (): number => cols.t.length,
    files: (): string[] => [...files.keys()],
    span: (): { from: number; to: number } | undefined =>
      cols.t.length === 0 ? undefined : { from: cols.t[0], to: cols.t[cols.t.length - 1] },
  };
};

export type HistoryStore = ReturnType<typeof HistoryStore>;
