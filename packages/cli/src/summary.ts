import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dayKeyFormatter, HISTORY_FILE_RE, resolvedTimeZone } from "./history";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A running total and the number of samples in it, so aggregates compose. */
type Acc = [sum: number, count: number];

const add = (a: Acc | undefined, v: number | undefined): Acc | undefined =>
  v === undefined ? a : a === undefined ? [v, 1] : [a[0] + v, a[1] + 1];

export type DeviceHour = {
  soc?: Acc;
  acIn?: Acc;
  acOut?: Acc;
  tgt?: Acc;
  /** Cycles seen in each AC mode; the dominant one is whichever counted most. */
  m?: Record<string, number>;
};

export type Hour = {
  /** Epoch ms of the hour start. A UTC instant, like every other value here. */
  t: number;
  solar?: Acc;
  acIn?: Acc;
  acOut?: Acc;
  bal?: Acc;
  /** Positional, aligned with the file's `devices` list. */
  dev: DeviceHour[];
  /** Keyed directly by panel name rather than a positional index like `dev`
   *  is: there are only ever a couple of panels, their names are short, and
   *  a panel has one figure (watts) rather than a battery's several, so the
   *  indirection a device list buys isn't worth a second registry here. */
  panels?: Record<string, Acc>;
};

export type MonthSummary = {
  month: string;
  /** The zone the month and day boundaries were taken in, recorded so that a
   *  file built under a different TZ is recognisable rather than silently
   *  mixed in. */
  timeZone: string;
  generatedAt: string;
  /** Raw files already folded in, by name. Re-running skips these, which is
   *  what makes the job idempotent and makes deleting a raw file safe: a file
   *  may only be deleted once it appears here.
   *
   *  Recorded per source file rather than per day on purpose. On the day the
   *  loop switched from one growing log to daily files, that day's cycles are
   *  split across `history.jsonl` and `history-<day>.jsonl`; keyed by day, the
   *  second one to be folded would be skipped and its half of the day lost. */
  sources: string[];
  devices: { sn: string; name: string }[];
  hours: Hour[];
};

type Rec = {
  timestamp?: string;
  totalSolarWatts?: number;
  solarByPanel?: Record<string, number>;
  totalAcInputWatts?: number;
  totalAcOutputWatts?: number;
  balanceWatts?: number;
  devices?: {
    sn?: string;
    name?: string;
    batterySoc?: number;
    acInputWatts?: number;
    acOutputWatts?: number;
    targetWatts?: number;
    mode?: string;
  }[];
};

/** Summaries live beside the raw logs they were derived from. */
export const summaryDir = (dataDir: string): string => join(dataDir, "summaries");
export const summaryFilePath = (dataDir: string, month: string): string =>
  join(summaryDir(dataDir), `${month}.json`);

const emptySummary = (month: string, timeZone: string): MonthSummary => ({
  month,
  timeZone,
  generatedAt: new Date().toISOString(),
  sources: [],
  devices: [],
  hours: [],
});

const readSummary = async (
  dataDir: string,
  month: string,
  timeZone: string,
): Promise<MonthSummary> => {
  try {
    const parsed = JSON.parse(await readFile(summaryFilePath(dataDir, month), "utf8")) as MonthSummary;
    // Tolerate a file written before a field existed rather than crashing on it.
    return {
      ...emptySummary(month, timeZone),
      ...parsed,
      sources: parsed.sources ?? [],
      devices: parsed.devices ?? [],
      hours: parsed.hours ?? [],
    };
  } catch {
    return emptySummary(month, timeZone);
  }
};

/**
 * Writes via a temporary file and a rename, so a summary is never left
 * half-written: the reader either sees the previous version or the new one.
 */
const writeSummary = async (dataDir: string, s: MonthSummary): Promise<void> => {
  await mkdir(summaryDir(dataDir), { recursive: true });
  const tmp = `${summaryFilePath(dataDir, s.month)}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ ...s, generatedAt: new Date().toISOString() })}\n`);
  await rename(tmp, summaryFilePath(dataDir, s.month));
};

/** Folds one day's records into the month they belong to, in place. */
export const foldRecords = (
  summary: MonthSummary,
  lines: string[],
  source: string,
): { added: number; skipped: number } => {
  const byHour = new Map<number, Hour>();
  for (const h of summary.hours) byHour.set(h.t, h);
  const deviceIndex = new Map<string, number>();
  summary.devices.forEach((d, i) => deviceIndex.set(d.sn, i));

  let added = 0;
  let skipped = 0;
  for (const line of lines) {
    if (line.length === 0) continue;
    let rec: Rec;
    try {
      rec = JSON.parse(line) as Rec;
    } catch {
      skipped += 1;
      continue;
    }
    const t = Date.parse(rec.timestamp ?? "");
    if (Number.isNaN(t)) {
      skipped += 1;
      continue;
    }
    // Hour buckets are plain UTC instants; only the day and month a record is
    // filed under consult the timezone, and that was decided by the caller.
    const hourStart = Math.floor(t / HOUR_MS) * HOUR_MS;
    let hour = byHour.get(hourStart);
    if (hour === undefined) {
      hour = { t: hourStart, dev: [] };
      byHour.set(hourStart, hour);
    }
    hour.solar = add(hour.solar, rec.totalSolarWatts);
    hour.acIn = add(hour.acIn, rec.totalAcInputWatts);
    hour.acOut = add(hour.acOut, rec.totalAcOutputWatts);
    hour.bal = add(hour.bal, rec.balanceWatts);

    for (const [name, watts] of Object.entries(rec.solarByPanel ?? {})) {
      hour.panels = hour.panels ?? {};
      // Not `add()`: watts here is always a real number (Object.entries never
      // yields an undefined value), so the sum is never left as `undefined`
      // the way add()'s general v-may-be-missing signature allows.
      const prev = hour.panels[name];
      hour.panels[name] = prev === undefined ? [watts, 1] : [prev[0] + watts, prev[1] + 1];
    }

    for (const d of rec.devices ?? []) {
      if (!d.sn) continue;
      let i = deviceIndex.get(d.sn);
      if (i === undefined) {
        i = summary.devices.length;
        summary.devices.push({ sn: d.sn, name: d.name ?? d.sn });
        deviceIndex.set(d.sn, i);
      } else if (d.name && summary.devices[i].name !== d.name) {
        summary.devices[i].name = d.name;
      }
      while (hour.dev.length <= i) hour.dev.push({});
      const dh = hour.dev[i];
      dh.soc = add(dh.soc, d.batterySoc);
      dh.acIn = add(dh.acIn, d.acInputWatts);
      dh.acOut = add(dh.acOut, d.acOutputWatts);
      dh.tgt = add(dh.tgt, d.targetWatts);
      if (d.mode) {
        dh.m = dh.m ?? {};
        dh.m[d.mode] = (dh.m[d.mode] ?? 0) + 1;
      }
    }
    added += 1;
  }

  summary.hours = [...byHour.values()].sort((a, b) => a.t - b.t);
  if (added > 0 && !summary.sources.includes(source)) {
    summary.sources.push(source);
    summary.sources.sort();
  }
  return { added, skipped };
};

export type SummarizeResult = {
  timeZone: string;
  folded: { source: string; months: string[]; records: number }[];
  deleted: string[];
  skippedToday: string | undefined;
};

/** The single growing log written before daily rotation, if it is still there. */
const LEGACY_NAME = "history.jsonl";
const MONTH_FILE_RE = /^(\d{4}-\d{2})\.json$/;

/**
 * Rolls raw history logs into per-month summaries, then deletes the raw files
 * that are both summarised and older than the retention window.
 *
 * Safe to run while the control loop is running, and safe to run twice: the
 * file for the current day is never touched, a file already recorded in a
 * month's `sources` is not folded again, and nothing is deleted that has not
 * been recorded as folded.
 */
export const summarize = async (opts: {
  dataDir: string;
  retentionDays: number;
  timeZone?: string;
  now?: Date;
}): Promise<SummarizeResult> => {
  const timeZone = opts.timeZone ?? resolvedTimeZone();
  const dayKey = dayKeyFormatter(opts.timeZone);
  const now = opts.now ?? new Date();
  const today = dayKey(now);
  const cutoff = now.getTime() - opts.retentionDays * DAY_MS;

  const entries = await readdir(opts.dataDir);

  // Every existing month is loaded up front: a source may span months (the
  // legacy log does), so "has this file been folded already?" cannot be
  // answered by looking at one month alone.
  const cache = new Map<string, MonthSummary>();
  for (const name of entries.includes("summaries") ? await readdir(summaryDir(opts.dataDir)) : []) {
    const m = MONTH_FILE_RE.exec(name);
    if (m) cache.set(m[1], await readSummary(opts.dataDir, m[1], timeZone));
  }
  const alreadyFolded = (source: string): boolean =>
    [...cache.values()].some((s) => s.sources.includes(source));

  const summaryFor = async (month: string): Promise<MonthSummary> => {
    let s = cache.get(month);
    if (s === undefined) {
      s = await readSummary(opts.dataDir, month, timeZone);
      cache.set(month, s);
    }
    return s;
  };

  type Source = { name: string; day: string | undefined };
  const sources: Source[] = [];
  if (entries.includes(LEGACY_NAME)) sources.push({ name: LEGACY_NAME, day: undefined });
  for (const name of entries) {
    const m = HISTORY_FILE_RE.exec(name);
    if (m) sources.push({ name, day: m[1] });
  }
  sources.sort((a, b) => (a.day ?? "").localeCompare(b.day ?? ""));

  const folded: SummarizeResult["folded"] = [];
  const touched = new Map<string, string[]>();

  for (const src of sources) {
    if (src.day === today) continue; // still being appended to
    if (alreadyFolded(src.name)) continue;

    const text = await readFile(join(opts.dataDir, src.name), "utf8");
    // Records are routed by their own timestamp, not by the file's name: the
    // legacy log spans months, and a daily file can still only hold one.
    const byMonth = new Map<string, string[]>();
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      let t: number;
      try {
        t = Date.parse((JSON.parse(line) as { timestamp?: string }).timestamp ?? "");
      } catch {
        continue;
      }
      if (Number.isNaN(t)) continue;
      const month = dayKey(new Date(t)).slice(0, 7);
      const bucket = byMonth.get(month);
      if (bucket) bucket.push(line);
      else byMonth.set(month, [line]);
    }

    let records = 0;
    const months: string[] = [];
    for (const [month, lines] of byMonth) {
      const summary = await summaryFor(month);
      records += foldRecords(summary, lines, src.name).added;
      months.push(month);
    }
    if (months.length > 0) {
      folded.push({ source: src.name, months: months.sort(), records });
      touched.set(src.name, months);
    }
  }

  for (const s of cache.values()) await writeSummary(opts.dataDir, s);

  const deleted: string[] = [];
  for (const src of sources) {
    if (src.day === today) continue;
    // Two independent conditions, both required: the file's numbers survive in
    // a summary, and nothing still on display needs its raw resolution.
    if (!alreadyFolded(src.name) && !touched.has(src.name)) continue;
    const newest =
      src.day !== undefined
        ? Date.parse(`${src.day}T23:59:59Z`)
        : // The legacy log stopped being written when the loop switched to
          // daily files, so its mtime is when its last record landed.
          (await stat(join(opts.dataDir, src.name))).mtimeMs;
    if (newest >= cutoff) continue;
    await unlink(join(opts.dataDir, src.name));
    deleted.push(src.name);
  }

  return {
    timeZone,
    folded,
    deleted,
    skippedToday: sources.some((f) => f.day === today) ? today : undefined,
  };
};
