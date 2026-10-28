import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SeriesBuilder } from "./buckets";

/**
 * What `soltrk summarize` writes, read defensively.
 *
 * As with the raw log, this package defines the shape it expects rather than
 * importing the writer's type: a summary on disk was produced by whatever
 * version of the loop was installed that month, and a field added later must
 * not make an older file unreadable.
 */
type Acc = [sum: number, count: number];

type Day = {
  t: number;
  solar?: Acc;
  acIn?: Acc;
  acOut?: Acc;
  bal?: Acc;
};

type MonthFile = {
  month?: string;
  timeZone?: string;
  days?: Day[];
};

const MONTH_RE = /^(\d{4}-\d{2})\.json$/;

type Loaded = { month: string; size: number; mtimeMs: number; days: Day[] };

const isAcc = (a: Acc | undefined): a is Acc =>
  Array.isArray(a) && a.length === 2 && Number.isFinite(a[0]) && a[1] > 0;

const HOUR_MS = 3_600_000;
/** A day's total is spread across 24 virtual hourly instants rather than
 *  dropped into whichever single bucket its one timestamp lands in - see
 *  `contribute` below for why. */
const HOURS_PER_DAY = 24;

/**
 * Serves the pre-aggregated months that `soltrk summarize` leaves behind, so
 * ranges longer than the raw retention window still have something to draw.
 *
 * Each file is read once and then only re-read if its size or mtime changed -
 * a completed month never changes, and the current month is rewritten at most
 * once a night.
 */
export const SummaryStore = (props: { dataDir: string }) => {
  const dir = join(props.dataDir, "summaries");
  const loaded = new Map<string, Loaded>();

  const refresh = async (): Promise<undefined | Error> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // No summaries yet is the normal state on a fresh install, not an error.
      loaded.clear();
      return undefined;
    }
    const months = entries.map((n) => ({ n, m: MONTH_RE.exec(n) })).filter((e) => e.m !== null);
    const present = new Set(months.map((e) => e.m![1]));
    for (const month of loaded.keys()) if (!present.has(month)) loaded.delete(month);

    for (const e of months) {
      const month = e.m![1];
      const path = join(dir, e.n);
      let st: { size: number; mtimeMs: number };
      try {
        st = await stat(path);
      } catch {
        loaded.delete(month);
        continue;
      }
      const have = loaded.get(month);
      if (have && have.size === st.size && have.mtimeMs === st.mtimeMs) continue;
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as MonthFile;
        loaded.set(month, {
          month,
          size: st.size,
          mtimeMs: st.mtimeMs,
          days: (parsed.days ?? []).filter((d) => Number.isFinite(d.t)),
        });
      } catch (err) {
        // A half-written or hand-edited month is skipped rather than fatal:
        // the rest of the archive is still worth showing.
        console.error(`[web] ignoring ${e.n}: ${(err as Error).message}`);
        loaded.delete(month);
      }
    }
    return undefined;
  };

  /**
   * Adds daily aggregates into the builder, spread across 24 virtual hourly
   * instants rather than dropped whole into whichever single bucket the
   * day's one timestamp lands in.
   *
   * This matters for more than drawing a shape: `/api/energy` builds its
   * series with one bucket per hour and then multiplies each bucket's mean
   * watts by one hour to get its energy. A day's true mean watts dropped into
   * a single hour-wide bucket would multiply by one hour instead of the
   * twenty-four its sum/count actually cover - undercounting that day's
   * energy by 24x. Dividing the sum and count by 24 and crediting them to each
   * of the day's 24 hours keeps the mean (and so the energy) correct no matter
   * what bucket width the caller is using, and happens to also be the honest
   * shape to chart: a flat line at the day's average, not a misleading spike
   * at one instant, since the average is all that survived.
   *
   * `before` is the instant the raw log takes over: an hour at or after it is
   * skipped, because the same cycles are already being contributed sample by
   * sample and would be counted twice.
   */
  const contribute = (b: SeriesBuilder, before: number): void => {
    for (const file of loaded.values()) {
      for (const d of file.days) {
        for (let h = 0; h < HOURS_PER_DAY; h += 1) {
          const t = d.t + h * HOUR_MS;
          if (t >= before) break;
          const i = b.indexOf(t);
          if (i < 0) continue;
          if (isAcc(d.solar)) b.addGlobal("solar", i, d.solar[0] / HOURS_PER_DAY, d.solar[1] / HOURS_PER_DAY);
          if (isAcc(d.acIn)) b.addGlobal("acIn", i, d.acIn[0] / HOURS_PER_DAY, d.acIn[1] / HOURS_PER_DAY);
          if (isAcc(d.acOut)) b.addGlobal("acOut", i, d.acOut[0] / HOURS_PER_DAY, d.acOut[1] / HOURS_PER_DAY);
          if (isAcc(d.bal)) b.addGlobal("balance", i, d.bal[0] / HOURS_PER_DAY, d.bal[1] / HOURS_PER_DAY);
        }
      }
    }
  };

  const span = (): { from: number; to: number } | undefined => {
    let from = Infinity;
    let to = -Infinity;
    for (const f of loaded.values()) {
      for (const d of f.days) {
        if (d.t < from) from = d.t;
        if (d.t > to) to = d.t;
      }
    }
    return from === Infinity ? undefined : { from, to };
  };

  return { refresh, contribute, span, months: (): string[] => [...loaded.keys()].sort() };
};

export type SummaryStore = ReturnType<typeof SummaryStore>;
