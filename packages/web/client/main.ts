import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import "./styles.css";

type Series = {
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
  available: { from: number; to: number } | null;
  sampleCount: number;
};

type StateDevice = {
  sn: string;
  name?: string;
  batterySoc?: number;
  acInputWatts?: number;
  acOutputWatts?: number;
  targetWatts?: number;
  mode?: string;
};
type State = {
  timestamp: string;
  totalSolarWatts?: number;
  balanceWatts?: number;
  devices?: StateDevice[];
};

const RANGES: { label: string; hours: number }[] = [
  { label: "6時間", hours: 6 },
  { label: "24時間", hours: 24 },
  { label: "3日", hours: 72 },
  { label: "7日", hours: 168 },
  { label: "30日", hours: 720 },
];

const MODE_COLOR: Record<string, string> = {
  charge: "--charge",
  passthrough: "--passthrough",
  battery: "--battery",
};

// A palette wide enough for the three units here, and for a fourth if one is
// ever added - read from CSS so the dark theme swaps with everything else.
const css = (name: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const DEVICE_STROKES = ["--soc", "--solar", "--export", "--import"];

let hours = 24;
const charts: uPlot[] = [];
/** The most recent history response, shared with the mode strips' repaint. */
let currentSeries: Series | undefined;
let repaintStrips: () => void = () => {};
/**
 * Called whenever a chart finishes sizing itself. uPlot works out how wide its
 * y-axis needs to be during the first draw, not in the constructor, so anything
 * that wants to line up with the plot area has to wait for this rather than
 * measure straight after `new uPlot(...)`.
 */
const onChartSized: (() => void)[] = [];
const notifySized = (): void => {
  for (const f of onChartSized) f();
};

const fmtW = (w: number | null | undefined): string =>
  w === null || w === undefined ? "—" : `${Math.round(w)}W`;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const renderRanges = (): void => {
  const nav = el("ranges");
  nav.replaceChildren(
    ...RANGES.map((r) => {
      const b = document.createElement("button");
      b.textContent = r.label;
      b.setAttribute("aria-pressed", String(r.hours === hours));
      b.addEventListener("click", () => {
        hours = r.hours;
        renderRanges();
        void refreshHistory();
      });
      return b;
    }),
  );
};

const renderNow = (state: State): void => {
  const cards: string[] = [];
  const bal = state.balanceWatts ?? 0;
  cards.push(
    `<div class="card"><div class="k">発電</div><div class="v">${fmtW(state.totalSolarWatts)}</div></div>`,
    `<div class="card"><div class="k">収支</div><div class="v" style="color:${bal < 0 ? css("--import") : css("--export")}">${bal < 0 ? "" : "+"}${Math.round(bal)}W</div>` +
      `<div class="s">${bal < 0 ? "グリッドから購入" : "余剰"}</div></div>`,
  );
  for (const d of state.devices ?? []) {
    const mode = d.mode ?? "—";
    cards.push(
      `<div class="card"><div class="k">${d.name ?? d.sn}</div>` +
        `<div class="v">${d.batterySoc === undefined ? "—" : `${d.batterySoc}%`}</div>` +
        `<div class="s"><span class="pill ${mode}">${mode}</span> ${fmtW(d.acInputWatts)} → ${fmtW(d.acOutputWatts)}</div></div>`,
    );
  }
  el("now").innerHTML = cards.join("");
  el("updated").textContent = `${new Date(state.timestamp).toLocaleString("ja-JP")} 更新`;
};

type SeriesDef = { label: string; data: (number | null)[]; color: string; dash?: number[] };

const makeChart = (
  host: HTMLElement,
  title: string,
  desc: string,
  xs: number[],
  defs: SeriesDef[],
  opts: { unit: string; zeroLine?: boolean },
): void => {
  const box = document.createElement("div");
  box.className = "chart";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = desc;
  const plot = document.createElement("div");
  box.append(h, p, plot);
  host.append(box);

  const data: uPlot.AlignedData = [xs, ...defs.map((d) => d.data)] as uPlot.AlignedData;
  const config: uPlot.Options = {
    width: plot.clientWidth || 800,
    height: 200,
    padding: [8, 8, 0, 0],
    cursor: { drag: { x: true, y: false } },
    scales: { x: { time: true } },
    axes: [
      { stroke: css("--muted"), grid: { stroke: css("--line") }, ticks: { stroke: css("--line") } },
      {
        stroke: css("--muted"),
        grid: { stroke: css("--line") },
        ticks: { stroke: css("--line") },
        values: (_u, vals) => vals.map((v) => `${v}${opts.unit}`),
      },
    ],
    series: [
      { value: (_u, v) => (v === null ? "" : new Date(v * 1000).toLocaleString("ja-JP")) },
      ...defs.map((d) => ({
        label: d.label,
        stroke: d.color,
        width: 1.6,
        dash: d.dash,
        spanGaps: false,
        value: (_u: uPlot, v: number | null) => (v === null ? "—" : `${Math.round(v)}${opts.unit}`),
      })),
    ],
    hooks: {
      ready: [notifySized],
      setSize: [notifySized],
      draw: opts.zeroLine
        ? [
            (u) => {
              const y = u.valToPos(0, "y", true);
              const { ctx } = u;
              ctx.save();
              ctx.strokeStyle = css("--muted");
              ctx.globalAlpha = 0.5;
              ctx.setLineDash([3, 3]);
              ctx.beginPath();
              ctx.moveTo(u.bbox.left, y);
              ctx.lineTo(u.bbox.left + u.bbox.width, y);
              ctx.stroke();
              ctx.restore();
            },
          ]
        : [],
    },
  };
  const u = new uPlot(config, data, plot);
  charts.push(u);
  new ResizeObserver(() => u.setSize({ width: plot.clientWidth, height: 200 })).observe(plot);
};

/**
 * Left and right gutters of the first chart's plot area, measured live off the
 * DOM. It has to be read at paint time rather than at build time: uPlot is
 * created at whatever width the container reports and then resized by a
 * ResizeObserver a frame later, so anything measured earlier is stale.
 */
const measureAlign = (): { left: number; right: number } => {
  const first = charts[0];
  const card = first?.root.closest(".chart") as HTMLElement | null;
  if (!first || !card) return { left: 64, right: 0 };
  const over = first.over.getBoundingClientRect();
  const rect = card.getBoundingClientRect();
  const cs = getComputedStyle(card);
  return {
    left: over.left - (rect.left + parseFloat(cs.paddingLeft)),
    right: rect.right - parseFloat(cs.paddingRight) - over.right,
  };
};

const makeModeStrips = (host: HTMLElement, s: Series): void => {
  const box = document.createElement("div");
  box.className = "chart";
  box.innerHTML =
    `<h2>ACモードの推移</h2>` +
    `<p>各ユニットが充電/パススルー/バッテリーのどれで動いていたか。6%下限でゲートが効くとパススルーに切り替わる。</p>`;
  const strips = document.createElement("div");
  strips.className = "modes";
  // Line the bands up with the plot area of the charts above: without this the
  // strip spans the full card while the charts are inset by their y-axis, and
  // a mode change reads as happening at the wrong time.
  const applyAlign = (): void => {
    const a = measureAlign();
    strips.style.setProperty("--pad-left", `${Math.max(0, a.left)}px`);
    strips.style.setProperty("--pad-right", `${Math.max(0, a.right)}px`);
  };
  applyAlign();
  onChartSized.push(applyAlign);
  box.append(strips);

  const repaints: (() => void)[] = [];
  for (const [di, d] of s.devices.entries()) {
    const row = document.createElement("div");
    row.className = "moderow";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = d.name;
    const canvas = document.createElement("canvas");
    row.append(nm, canvas);
    strips.append(row);

    const paint = (): void => {
      applyAlign();
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      const modes = currentSeries?.devices[di]?.mode ?? d.mode;
      const n = modes.length;
      const bw = w / Math.max(1, n);
      for (let i = 0; i < n; i += 1) {
        const m = modes[i];
        if (m === null) continue;
        ctx.fillStyle = css(MODE_COLOR[m] ?? "--muted");
        // +1 so neighbouring buckets of the same mode read as one solid band
        // instead of a picket fence of hairline gaps.
        ctx.fillRect(i * bw, 0, bw + 1, h);
      }
    };
    paint();
    repaints.push(paint);
    new ResizeObserver(paint).observe(canvas);
    onChartSized.push(paint);
  }

  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML = Object.entries(MODE_COLOR)
    .map(([m, v]) => `<span><i style="background:${css(v)}"></i>${m}</span>`)
    .join("");
  box.append(legend);
  host.append(box);
  repaintStrips = () => {
    for (const f of repaints) f();
  };
};

/**
 * The control loop's own period. state.json is rewritten once per cycle and
 * the solar readings behind it arrive on the same 30s beat, so polling faster
 * returns identical bytes.
 */
const STATE_POLL_MS = 30_000;
/** However wide the buckets get, check back at least this often. */
const HISTORY_POLL_MAX_MS = 10 * 60_000;

/** Columnar data for each chart, in the order buildCharts creates them. */
const seriesData = (s: Series): uPlot.AlignedData[] => {
  const xs = s.t.map((ms) => ms / 1000);
  return [
    [xs, s.solar, s.balance],
    [xs, ...s.devices.map((d) => d.soc)],
    [xs, ...s.devices.flatMap((d) => [d.acIn, d.target])],
  ] as unknown as uPlot.AlignedData[];
};

const buildCharts = (s: Series): void => {
  const host = el("charts");
  for (const c of charts.splice(0)) c.destroy();
  onChartSized.splice(0);
  repaintStrips = () => {};
  host.replaceChildren();

  const xs = s.t.map((ms) => ms / 1000);

  makeChart(
    host,
    "発電と収支",
    "収支は 発電 − 家の想定負荷 − 各ユニットのAC取り込み。0を下回っている間はグリッドから買っている(意図した運転点)。",
    xs,
    [
      { label: "発電", data: s.solar, color: css("--solar") },
      { label: "収支", data: s.balance, color: css("--import") },
    ],
    { unit: "W", zeroLine: true },
  );

  makeChart(
    host,
    "バッテリー残量",
    "6%が放電下限。ここに張り付いている間は蓄電の余裕がない。",
    xs,
    s.devices.map((d, i) => ({
      label: d.name,
      data: d.soc,
      color: css(DEVICE_STROKES[i % DEVICE_STROKES.length]),
    })),
    { unit: "%" },
  );

  makeChart(
    host,
    "充電指令 vs 実測AC取り込み",
    "破線が指令(targetWatts)、実線が実測。立ち上がりでどれだけ遅れるかがそのまま追従性能。",
    xs,
    s.devices.flatMap((d, i) => [
      { label: `${d.name} 実測`, data: d.acIn, color: css(DEVICE_STROKES[i % DEVICE_STROKES.length]) },
      {
        label: `${d.name} 指令`,
        data: d.target,
        color: css(DEVICE_STROKES[i % DEVICE_STROKES.length]),
        dash: [4, 4],
      },
    ]),
    { unit: "W" },
  );

  makeModeStrips(host, s);
  // The charts were built before the strips existed, so their `ready` hooks
  // fired into an empty listener list. Run one alignment pass now that both
  // sides are in place.
  notifySized();
};

/**
 * Push new numbers into the existing charts rather than rebuilding them. The
 * page is meant to be left open, and a rebuild every cycle threw away whatever
 * range the reader had dragged out, on top of flickering.
 */
const updateCharts = (s: Series): void => {
  const data = seriesData(s);
  charts.forEach((u, i) => {
    const d = data[i];
    if (d === undefined) return;
    const xs = d[0] as number[];
    // Follow the live edge only while the view still spans the whole series;
    // once the reader has zoomed in, keep their window.
    const atFullExtent =
      xs.length > 0 &&
      u.scales.x.min !== undefined &&
      u.scales.x.max !== undefined &&
      u.scales.x.min <= xs[0] &&
      u.scales.x.max >= xs[xs.length - 1];
    u.setData(d, atFullExtent);
  });
  repaintStrips();
};

const renderMeta = (s: Series): void => {
  const av = s.available;
  el("meta").textContent = av
    ? `記録期間 ${new Date(av.from).toLocaleDateString("ja-JP")} 〜 ${new Date(av.to).toLocaleDateString("ja-JP")} / ${s.sampleCount.toLocaleString()} サイクル / バケット ${Math.round(s.bucketMs / 1000)}秒`
    : "履歴なし";
};

let historyTimer: number | undefined;
/** Device set the current charts were built for; a change forces a rebuild. */
let builtFor = "";

const scheduleHistory = (bucketMs: number): void => {
  if (historyTimer !== undefined) clearTimeout(historyTimer);
  // A bucket cannot change faster than it is wide, so re-querying sooner just
  // re-sends identical numbers - and makes the Pi rescan the whole file to do
  // it. The 30-day view has 72-minute buckets; the 6-hour view lands on the
  // control period, which is the floor.
  const delay = Math.min(HISTORY_POLL_MAX_MS, Math.max(STATE_POLL_MS, bucketMs));
  historyTimer = window.setTimeout(() => void refreshHistory(), delay);
};

const refreshHistory = async (): Promise<void> => {
  let s: Series;
  try {
    s = (await fetch(`/api/history?hours=${hours}&buckets=600`).then((r) => r.json())) as Series;
  } catch (err) {
    console.error("[soltrk] history refresh failed", err);
    scheduleHistory(STATE_POLL_MS);
    return;
  }
  currentSeries = s;
  const key = `${hours}:${s.devices.map((d) => d.sn).join(",")}`;
  if (key !== builtFor || charts.length === 0) {
    builtFor = key;
    buildCharts(s);
  } else {
    updateCharts(s);
  }
  renderMeta(s);
  scheduleHistory(s.bucketMs);
};

const refreshState = async (): Promise<void> => {
  try {
    renderNow((await fetch("/api/state").then((r) => r.json())) as State);
  } catch (err) {
    console.error("[soltrk] state refresh failed", err);
  }
};

renderRanges();
void refreshState();
void refreshHistory();
setInterval(() => void refreshState(), STATE_POLL_MS);
