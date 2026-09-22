import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DeviceMeta, SeriesBuilder } from "./buckets";

/**
 * What `soltrk summarize` writes, read defensively.
 *
 * As with the raw log, this package defines the shape it expects rather than
 * importing the writer's type: a summary on disk was produced by whatever
 * version of the loop was installed that month, and a field added later must
 * not make an older file unreadable.
 */
type Acc = [sum: number, count: number];

type DeviceHour = {
  soc?: Acc;
  acIn?: Acc;
  acOut?: Acc;
  tgt?: Acc;
  m?: Record<string, number>;
};

type Hour = {
  t: number;
  solar?: Acc;
  acIn?: Acc;
  acOut?: Acc;
  bal?: Acc;
  dev?: DeviceHour[];
  /** Keyed directly by panel name, matching how the writer stores it (see
   *  cli/summary.ts) - there is no positional device-style registry for
   *  panels, since a panel's name already is its identity. */
  panels?: Record<string, Acc>;
};

type MonthFile = {
  month?: string;
  timeZone?: string;
  devices?: { sn?: string; name?: string }[];
  hours?: Hour[];
};

const MONTH_RE = /^(\d{4}-\d{2})\.json$/;

type Loaded = { month: string; size: number; mtimeMs: number; devices: DeviceMeta[]; hours: Hour[] };

const isAcc = (a: Acc | undefined): a is Acc =>
  Array.isArray(a) && a.length === 2 && Number.isFinite(a[0]) && a[1] > 0;

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
          devices: (parsed.devices ?? [])
            .filter((d): d is { sn: string; name?: string } => typeof d.sn === "string")
            .map((d) => ({ sn: d.sn, name: d.name ?? d.sn })),
          hours: (parsed.hours ?? []).filter((h) => Number.isFinite(h.t)),
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
   * Adds hourly aggregates into the builder. `before` is the instant the raw
   * log takes over: hours at or after it are skipped, because the same cycles
   * are already being contributed sample by sample and would be counted twice.
   */
  const contribute = (b: SeriesBuilder, before: number): void => {
    for (const file of loaded.values()) {
      for (const h of file.hours) {
        if (h.t >= before) continue;
        const i = b.indexOf(h.t);
        if (i < 0) continue;
        if (isAcc(h.solar)) b.addGlobal("solar", i, h.solar[0], h.solar[1]);
        if (isAcc(h.acIn)) b.addGlobal("acIn", i, h.acIn[0], h.acIn[1]);
        if (isAcc(h.acOut)) b.addGlobal("acOut", i, h.acOut[0], h.acOut[1]);
        if (isAcc(h.bal)) b.addGlobal("balance", i, h.bal[0], h.bal[1]);

        (h.dev ?? []).forEach((d, di) => {
          const meta = file.devices[di];
          if (meta === undefined) return; // positional, so an unknown slot is unusable
          if (isAcc(d.soc)) b.addDevice(meta, "soc", i, d.soc[0], d.soc[1]);
          if (isAcc(d.acIn)) b.addDevice(meta, "acIn", i, d.acIn[0], d.acIn[1]);
          if (isAcc(d.acOut)) b.addDevice(meta, "acOut", i, d.acOut[0], d.acOut[1]);
          if (isAcc(d.tgt)) b.addDevice(meta, "target", i, d.tgt[0], d.tgt[1]);
          for (const [mode, n] of Object.entries(d.m ?? {})) b.addMode(meta, mode, i, n);
        });

        for (const [name, acc] of Object.entries(h.panels ?? {})) {
          if (isAcc(acc)) b.addPanel(name, i, acc[0], acc[1]);
        }
      }
    }
  };

  const span = (): { from: number; to: number } | undefined => {
    let from = Infinity;
    let to = -Infinity;
    for (const f of loaded.values()) {
      for (const h of f.hours) {
        if (h.t < from) from = h.t;
        if (h.t > to) to = h.t;
      }
    }
    return from === Infinity ? undefined : { from, to };
  };

  return { refresh, contribute, span, months: (): string[] => [...loaded.keys()].sort() };
};

export type SummaryStore = ReturnType<typeof SummaryStore>;
