export type DeviceMeta = { sn: string; name: string };

export type Series = {
  from: number;
  to: number;
  bucketMs: number;
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
    mode: (string | null)[];
  }[];
};

/** AC modes are a closed set, so a bucket can just count each one. */
export const MODES = ["charge", "passthrough", "battery"] as const;
export type Mode = (typeof MODES)[number];

/** A running total and the number of samples in it, per bucket. */
type Acc = { s: number[]; n: number[] };

const newAcc = (count: number): Acc => ({
  s: new Array<number>(count).fill(0),
  n: new Array<number>(count).fill(0),
});

const meanOf = (a: Acc): (number | null)[] => a.s.map((s, i) => (a.n[i] === 0 ? null : s / a.n[i]));

type DeviceAccs = {
  meta: DeviceMeta;
  soc: Acc;
  acIn: Acc;
  acOut: Acc;
  target: Acc;
  modes: number[][];
};

/**
 * Accumulates a time range into fixed buckets, as sums and counts.
 *
 * Sums and counts rather than means, because two sources feed the same
 * buckets: raw 30s cycles for the recent window, and hourly aggregates from
 * the monthly summaries for anything older. An hour that stands for 120 cycles
 * has to weigh 120 times as much as a single cycle when they land in the same
 * bucket, and only a count can say so. Averaging each source first and then
 * averaging the averages would quietly mis-weight the boundary bucket.
 */
export const SeriesBuilder = (opts: { from: number; to: number; buckets: number }) => {
  const span = Math.max(1, opts.to - opts.from);
  const bucketMs = Math.max(1000, Math.ceil(span / Math.max(1, opts.buckets)));
  const count = Math.ceil(span / bucketMs);

  const globals = {
    solar: newAcc(count),
    acIn: newAcc(count),
    acOut: newAcc(count),
    balance: newAcc(count),
  };
  const devices: DeviceAccs[] = [];
  const bySn = new Map<string, number>();

  const deviceAt = (meta: DeviceMeta): DeviceAccs => {
    const known = bySn.get(meta.sn);
    if (known !== undefined) {
      if (meta.name && devices[known].meta.name !== meta.name) devices[known].meta.name = meta.name;
      return devices[known];
    }
    const d: DeviceAccs = {
      meta: { ...meta },
      soc: newAcc(count),
      acIn: newAcc(count),
      acOut: newAcc(count),
      target: newAcc(count),
      modes: MODES.map(() => new Array<number>(count).fill(0)),
    };
    bySn.set(meta.sn, devices.length);
    devices.push(d);
    return d;
  };

  /** Bucket index for an instant, or -1 when it falls outside the range. */
  const indexOf = (t: number): number =>
    t < opts.from || t >= opts.to ? -1 : Math.min(count - 1, Math.floor((t - opts.from) / bucketMs));

  return {
    bucketMs,
    count,
    indexOf,
    addGlobal(field: keyof typeof globals, b: number, sum: number, n: number): void {
      globals[field].s[b] += sum;
      globals[field].n[b] += n;
    },
    addDevice(
      meta: DeviceMeta,
      field: "soc" | "acIn" | "acOut" | "target",
      b: number,
      sum: number,
      n: number,
    ): void {
      const d = deviceAt(meta);
      d[field].s[b] += sum;
      d[field].n[b] += n;
    },
    addMode(meta: DeviceMeta, mode: string, b: number, n: number): void {
      const i = MODES.indexOf(mode as Mode);
      if (i >= 0) deviceAt(meta).modes[i][b] += n;
    },
    /** Registers a device even if it has no readings, so it keeps its slot. */
    touchDevice(meta: DeviceMeta): void {
      deviceAt(meta);
    },
    finish(): Series {
      const t: number[] = [];
      for (let i = 0; i < count; i += 1) t.push(opts.from + i * bucketMs);
      return {
        from: opts.from,
        to: opts.to,
        bucketMs,
        t,
        solar: meanOf(globals.solar),
        acIn: meanOf(globals.acIn),
        acOut: meanOf(globals.acOut),
        balance: meanOf(globals.balance),
        devices: devices.map((d) => ({
          sn: d.meta.sn,
          name: d.meta.name,
          soc: meanOf(d.soc),
          acIn: meanOf(d.acIn),
          acOut: meanOf(d.acOut),
          target: meanOf(d.target),
          // Whichever mode held for most of the bucket; a blip should not win.
          mode: t.map((_, b) => {
            let best = -1;
            let bestN = 0;
            for (let m = 0; m < MODES.length; m += 1) {
              if (d.modes[m][b] > bestN) {
                bestN = d.modes[m][b];
                best = m;
              }
            }
            return best < 0 ? null : MODES[best];
          }),
        })),
      };
    },
  };
};

export type SeriesBuilder = ReturnType<typeof SeriesBuilder>;
