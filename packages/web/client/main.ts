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
  panels: {
    name: string;
    watts: (number | null)[];
  }[];
  available: { from: number; to: number } | null;
  sampleCount: number;
  /** Where the raw 30s log starts; anything before it came from a summary. */
  rawFrom: number | null;
  months: string[];
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
type Energy = {
  yenPerKwh: number;
  houseStandbyWatts: number;
  since: number | null;
  today: Totals;
  month: Totals;
  total: Totals;
};
type Totals = { generatedKwh: number; usedKwh: number; yen: number };

type State = {
  timestamp: string;
  totalSolarWatts?: number;
  solarByPanel?: Record<string, number>;
  balanceWatts?: number;
  devices?: StateDevice[];
};

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The seek bar never looks back further than this, regardless of how much
 *  history the Pi is holding - a deliberate cap, not the retention window. */
const OVERVIEW_SPAN_MS = 30 * DAY_MS;
/** Width of the selection window when the page first loads. */
const DEFAULT_WINDOW_MS = DAY_MS;
/** Can't drag a handle past this - a window narrower than a few buckets'
 *  worth of the finest resolution would just show noise. */
const MIN_WINDOW_MS = 10 * 60_000;

const TABS: { id: "now" | "history"; label: string }[] = [
  { id: "now", label: "現在" },
  { id: "history", label: "履歴" },
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

let activeTab: "now" | "history" = "now";
/** The detail charts' currently selected window - what the seek bar's box
 *  spans, and what /api/history is asked for. */
let selFrom = Date.now() - DEFAULT_WINDOW_MS;
let selTo = Date.now();
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

const renderTabs = (): void => {
  const nav = el("tabs");
  nav.replaceChildren(
    ...TABS.map((t) => {
      const b = document.createElement("button");
      b.textContent = t.label;
      b.setAttribute("aria-pressed", String(t.id === activeTab));
      b.addEventListener("click", () => {
        activeTab = t.id;
        renderTabs();
        el("tab-now").hidden = activeTab !== "now";
        el("tab-history").hidden = activeTab !== "history";
        // Nothing to resize by hand: every chart here already has a
        // ResizeObserver on its container (see makeChart / buildOverview),
        // and going from `hidden` to visible is itself a resize those fire
        // on - same mechanism that keeps them correctly sized on a window
        // resize.
      });
      return b;
    }),
  );
};

const yen = (n: number): string => `${Math.round(n).toLocaleString()}円`;
const kwh = (n: number): string => `${n.toFixed(n < 10 ? 2 : 1)} kWh`;

const renderSavings = (e: Energy): void => {
  const since = e.since ? new Date(e.since).toLocaleDateString("ja-JP") : null;
  const cards: [string, Totals, string][] = [
    ["今日の節約", e.today, ""],
    ["今月", e.month, ""],
    ["累計", e.total, since ? `${since} から` : ""],
  ];
  el("savings").innerHTML = cards
    .map(
      ([label, t, note]) =>
        `<div class="card"><div class="k">${label}</div>` +
        `<div class="v">${yen(t.yen)}</div>` +
        `<div class="s">${kwh(t.usedKwh)}${note ? ` / ${note}` : ""}</div></div>`,
    )
    .join("");
};

/**
 * Where this cycle's generation went, using only what is actually metered.
 *
 * The four figures partition the solar, to within METER_NOISE_WATTS per unit:
 *   solar = used + charging - discharging + remaining
 * because the units' total AC input is their output plus whatever they kept
 * (or minus whatever they gave back from the battery). What the page cannot
 * show is the rest of the house - lights, ventilation, the air purifiers - which
 * is not on any unit and not metered. That is where "remaining" goes, so a
 * positive remainder is NOT a surplus: it is consumed by loads this system
 * cannot see, and the house may well still be importing. The card used to say
 * "余剰" and was wrong for exactly that reason.
 */
/**
 * Below this, a gap between a unit's AC input and output is meter noise, not a
 * battery doing anything. In passthrough the two should be identical and
 * measure a few watts apart - one reading of 88W in and 92W out would otherwise
 * be announced as "放電 4W". Real charging starts at the 30W floor plus the
 * charger's overhead, and a unit on its battery carries a real load, so nothing
 * genuine is lost below 10W.
 */
const METER_NOISE_WATTS = 10;

const flows = (state: State) => {
  let used = 0;
  let charging = 0;
  let discharging = 0;
  for (const d of state.devices ?? []) {
    const input = d.acInputWatts ?? 0;
    const output = d.acOutputWatts ?? 0;
    used += output;
    const gap = input - output;
    if (gap > METER_NOISE_WATTS) charging += gap;
    else if (-gap > METER_NOISE_WATTS) discharging += -gap;
  }
  // Same as the loop's balanceWatts: solar minus the units' total AC input.
  const remaining = state.balanceWatts ?? 0;
  return { used, charging, discharging, remaining };
};

/**
 * Panel names seen in any /api/state response so far this page load. A panel
 * is simply absent from solarByPanel when it hasn't reported this cycle
 * (never present at 0 - see SolarSource's port doc), which during e.g. a
 * wifi dropout would otherwise make the card row silently shrink to "there is
 * only one panel" instead of showing the missing one as unreachable. There is
 * no registry endpoint to seed this from up front, so it starts empty and
 * only grows - a panel that has never reported since the page opened stays
 * unlisted, same as it already isn't counted in the total.
 */
const knownPanels = new Set<string>();

const renderNow = (state: State): void => {
  const f = flows(state);
  const card = (k: string, v: string, sub: string, colour?: string): string =>
    `<div class="card"><div class="k">${k}</div>` +
    `<div class="v"${colour ? ` style="color:${colour}"` : ""}>${v}</div>` +
    `<div class="s">${sub}</div></div>`;

  // Two groups - what the panels made, and what the batteries did with it -
  // rather than one long row where a generation figure sits next to a
  // battery figure with nothing marking the seam between them.
  const panelCards: string[] = [card("発電", fmtW(state.totalSolarWatts), "")];
  for (const name of Object.keys(state.solarByPanel ?? {})) knownPanels.add(name);
  [...knownPanels].forEach((name, i) => {
    const watts = state.solarByPanel?.[name];
    panelCards.push(
      `<div class="card"><div class="k"><i class="dot" style="background:${css(DEVICE_STROKES[i % DEVICE_STROKES.length])}"></i>${name}</div>` +
        `<div class="v">${fmtW(watts)}</div>` +
        `<div class="s">${watts === undefined ? "応答なし" : ""}</div></div>`,
    );
  });

  const batteryCards: string[] = [
    card("使用量", fmtW(f.used), "3台につないだ負荷"),
    // acIn - acOut includes the ~33W the charger loses as heat, so this is what
    // went into the units rather than what ended up stored.
    card("充電", fmtW(f.charging), f.discharging > 0 ? `放電 ${fmtW(f.discharging)}` : "変換ロス込み"),
    card(
      "3台に回した後の残り",
      `${f.remaining < 0 ? "" : "+"}${Math.round(f.remaining)}W`,
      f.remaining < 0 ? "3台だけで発電を超過・購入中" : "照明・換気など計測外の負荷へ",
      f.remaining < 0 ? css("--import") : undefined,
    ),
  ];
  for (const d of state.devices ?? []) {
    const mode = d.mode ?? "—";
    batteryCards.push(
      `<div class="card"><div class="k">${d.name ?? d.sn}</div>` +
        `<div class="v">${d.batterySoc === undefined ? "—" : `${d.batterySoc}%`}</div>` +
        `<div class="s"><span class="pill ${mode}">${mode}</span> ${fmtW(d.acInputWatts)} → ${fmtW(d.acOutputWatts)}</div></div>`,
    );
  }

  el("panels").innerHTML = panelCards.join("");
  el("battery").innerHTML = batteryCards.join("");
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
    // No drag-to-zoom here: the seek bar is now the one control that picks
    // what span is fetched and shown, so an independent in-chart zoom on top
    // of it would just be a second, conflicting way to do the same thing.
    // The hover crosshair and its legend (uPlot's default) stay on.
    cursor: { drag: { x: false, y: false } },
    scales: { x: { time: true } },
    axes: [
      { stroke: css("--muted"), grid: { stroke: css("--line") }, ticks: { stroke: css("--line") } },
      {
        stroke: css("--muted"),
        grid: { stroke: css("--line") },
        ticks: { stroke: css("--line") },
        // SOC is only ever reported in whole percent, so let uPlot pick from
        // integer steps. Left to itself over a range pinned near 6% it chooses
        // 0.025 steps, and "5.975%" is both meaningless and too wide for the
        // axis gutter, so the label gets clipped to "975%".
        incrs: opts.unit === "%" ? [1, 2, 5, 10, 20, 25, 50, 100] : undefined,
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
 * The seek bar: a month-long solar sparkline with a draggable, resizable
 * window over it (the same idea as a stock chart's range brush), which picks
 * the span the detail charts below it are fetched for.
 */
let overviewChart: uPlot | undefined;
let overviewBounds = { from: Date.now() - OVERVIEW_SPAN_MS, to: Date.now() };
/** True while the window's right edge tracks "now" rather than sitting where
 *  the reader dragged it back to - mirrors the old range-button behaviour of
 *  following the live edge unless the reader had zoomed into the past. */
let followLive = true;
/** How much slack counts as "still at the live edge" - without this, the
 *  window would read as "not live" the instant any real time elapsed after a
 *  drag, since selTo is a fixed instant and the clock keeps moving. */
const LIVE_EDGE_SLACK_MS = 2 * 60_000;

const buildOverview = (s: Series): void => {
  const host = el("seek-chart");
  overviewChart?.destroy();
  const xs = s.t.map((ms) => ms / 1000);
  const config: uPlot.Options = {
    width: host.clientWidth || 800,
    height: 56,
    padding: [4, 0, 0, 0],
    cursor: { show: false },
    legend: { show: false },
    scales: { x: { time: true } },
    axes: [
      {
        stroke: css("--muted"),
        grid: { show: false },
        ticks: { show: false },
        size: 16,
        values: (_u, vals) =>
          vals.map((v) => new Date(v * 1000).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })),
      },
      { show: false }, // no unit on a sparkline - only the shape matters here
    ],
    series: [{}, { stroke: css("--solar"), width: 1.3, spanGaps: true }],
    hooks: { setSize: [layoutSeekWindow], ready: [layoutSeekWindow] },
  };
  overviewChart = new uPlot(config, [xs, s.solar] as unknown as uPlot.AlignedData, host);
  new ResizeObserver(() => overviewChart?.setSize({ width: host.clientWidth, height: 56 })).observe(host);

  overviewBounds = s.available
    ? { from: Math.max(s.available.from, Date.now() - OVERVIEW_SPAN_MS), to: s.available.to }
    : overviewBounds;
  selFrom = Math.max(overviewBounds.from, Math.min(selFrom, overviewBounds.to - MIN_WINDOW_MS));
  selTo = Math.min(overviewBounds.to, Math.max(selTo, selFrom + MIN_WINDOW_MS));
  layoutSeekWindow();
};

/** Positions the #seek-window overlay to match [selFrom, selTo] in pixels. */
function layoutSeekWindow(): void {
  if (!overviewChart) return;
  const win = el("seek-window");
  const seek = el("seek");
  const overRect = overviewChart.over.getBoundingClientRect();
  const seekRect = seek.getBoundingClientRect();
  const offsetX = overRect.left - seekRect.left;
  const x1 = overviewChart.valToPos(selFrom / 1000, "x");
  const x2 = overviewChart.valToPos(selTo / 1000, "x");
  win.style.left = `${offsetX + x1}px`;
  win.style.width = `${Math.max(4, x2 - x1)}px`;
}

/** Milliseconds represented by one CSS pixel of the overview's x-axis - the
 *  scale's slope, which is independent of where its plot area actually sits
 *  on screen, so drag deltas don't need the plot's own pixel origin at all. */
const msPerPx = (): number => {
  if (!overviewChart) return 0;
  const t0 = overviewChart.posToVal(0, "x");
  const t1 = overviewChart.posToVal(100, "x");
  return ((t1 - t0) * 1000) / 100;
};

type DragMode = "pan" | "left" | "right";
let drag: { mode: DragMode; startClientX: number; startFrom: number; startTo: number } | undefined;

const onSeekPointerMove = (e: PointerEvent): void => {
  if (!drag) return;
  const dxMs = (e.clientX - drag.startClientX) * msPerPx();
  if (drag.mode === "pan") {
    const width = drag.startTo - drag.startFrom;
    let from = drag.startFrom + dxMs;
    let to = drag.startTo + dxMs;
    if (from < overviewBounds.from) {
      from = overviewBounds.from;
      to = from + width;
    }
    if (to > overviewBounds.to) {
      to = overviewBounds.to;
      from = to - width;
    }
    selFrom = from;
    selTo = to;
  } else if (drag.mode === "left") {
    selFrom = Math.max(overviewBounds.from, Math.min(drag.startFrom + dxMs, selTo - MIN_WINDOW_MS));
  } else {
    selTo = Math.min(overviewBounds.to, Math.max(drag.startTo + dxMs, selFrom + MIN_WINDOW_MS));
  }
  layoutSeekWindow();
};

const onSeekPointerUp = (): void => {
  if (!drag) return;
  drag = undefined;
  followLive = overviewBounds.to - selTo < LIVE_EDGE_SLACK_MS;
  void refreshHistory();
};

/** Wires one drag surface (the window body, or an edge handle) to a mode.
 *  `stop` prevents a handle's pointerdown from also bubbling up into the
 *  window body's own "pan" handler - a grab on the edge must mean resize,
 *  not resize-and-pan-at-once. */
const bindSeekDrag = (target: HTMLElement, mode: DragMode, stop: boolean): void => {
  target.addEventListener("pointerdown", (e) => {
    if (stop) e.stopPropagation();
    e.preventDefault();
    target.setPointerCapture(e.pointerId);
    drag = { mode, startClientX: e.clientX, startFrom: selFrom, startTo: selTo };
  });
  target.addEventListener("pointermove", onSeekPointerMove);
  target.addEventListener("pointerup", onSeekPointerUp);
  target.addEventListener("pointercancel", onSeekPointerUp);
};

bindSeekDrag(el("seek-window"), "pan", false);
bindSeekDrag(el("seek-handle-left"), "left", true);
bindSeekDrag(el("seek-handle-right"), "right", true);

const refreshOverview = async (): Promise<void> => {
  try {
    const to = Date.now();
    const from = to - OVERVIEW_SPAN_MS;
    const s = (await fetch(`/api/history?from=${from}&to=${to}&buckets=240`).then((r) => r.json())) as Series;
    buildOverview(s);
  } catch (err) {
    console.error("[soltrk] overview refresh failed", err);
  }
};

/**
 * The control loop's own period. state.json is rewritten once per cycle and
 * the solar readings behind it arrive on the same 30s beat, so polling faster
 * returns identical bytes.
 */
const STATE_POLL_MS = 30_000;
/** However wide the buckets get, check back at least this often. */
const HISTORY_POLL_MAX_MS = 10 * 60_000;
/** The overview is a coarse 30-day sparkline - nothing is lost by checking
 *  back on it far less often than the detail charts. */
const OVERVIEW_POLL_MS = 5 * 60_000;

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
    "発電と、3台に回した後の残り",
    "残り = 発電 − 3台のAC取り込み。0を下回っている間は3台だけで発電を超えていてグリッドから買っている。" +
      "上回っていても照明・換気など計測外の負荷に回るので、余っているとは限らない。",
    xs,
    [
      { label: "発電", data: s.solar, color: css("--solar") },
      { label: "残り", data: s.balance, color: css("--import") },
    ],
    { unit: "W", zeroLine: true },
  );

  // Absent rather than empty when nothing has reported a breakdown yet -
  // either this range predates per-panel tracking, or the loop hasn't been
  // restarted onto it - so there is no line with literally nothing in it.
  if (s.panels.length > 0) {
    makeChart(
      host,
      "パネルごとの発電",
      "各インバーターの実測出力。合計が上の「発電」になる。",
      xs,
      s.panels.map((pn, i) => ({
        label: pn.name,
        data: pn.watts,
        color: css(DEVICE_STROKES[i % DEVICE_STROKES.length]),
      })),
      { unit: "W" },
    );
  }

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
 * Push new numbers into the existing charts rather than rebuilding them - a
 * rebuild every cycle would flicker and, before the seek bar existed, threw
 * away an in-chart zoom the reader had dragged out by hand. There is no
 * in-chart zoom to preserve any more (the seek bar is the one thing that
 * picks the span), so every update resets the x-scale to whatever span was
 * just fetched.
 */
const updateCharts = (s: Series): void => {
  const data = seriesData(s);
  charts.forEach((u, i) => {
    const d = data[i];
    if (d === undefined) return;
    u.setData(d, true);
  });
  repaintStrips();
};

const renderMeta = (s: Series): void => {
  const av = s.available;
  if (!av) {
    el("meta").textContent = "履歴なし";
    return;
  }
  const dt = (t: number) => new Date(t).toLocaleString("ja-JP");
  const bucket =
    s.bucketMs >= 3_600_000
      ? `${(s.bucketMs / 3_600_000).toFixed(1)}時間`
      : `${Math.round(s.bucketMs / 1000)}秒`;
  const parts = [
    `表示中 ${dt(s.from)} 〜 ${dt(s.to)}`,
    `バケット ${bucket}`,
    `記録は ${new Date(av.from).toLocaleDateString("ja-JP")} から (${s.sampleCount.toLocaleString()} サイクル)`,
  ];
  // Say plainly where the numbers stop being individual cycles, so nobody
  // reads an hourly average as if it were 30-second data.
  if (s.rawFrom !== null && s.from < s.rawFrom) {
    parts.push(`${new Date(s.rawFrom).toLocaleDateString("ja-JP")} より前は月次サマリー(1時間平均)`);
  }
  el("meta").textContent = parts.join(" / ");
};

let historyTimer: number | undefined;
/** Device set the current charts were built for; a change forces a rebuild. */
let builtFor = "";

const scheduleHistory = (bucketMs: number): void => {
  if (historyTimer !== undefined) clearTimeout(historyTimer);
  // A bucket cannot change faster than it is wide, so re-querying sooner just
  // re-sends identical numbers - and makes the Pi rescan the whole file to do
  // it. A month-wide window has 72-minute buckets; a few-hours-wide one lands
  // on the control period, which is the floor.
  const delay = Math.min(HISTORY_POLL_MAX_MS, Math.max(STATE_POLL_MS, bucketMs));
  historyTimer = window.setTimeout(() => {
    // Keep the window's width but slide it to the live edge - the seek-bar
    // equivalent of the old range buttons' "always shows up to now" behaviour
    // - but only while the reader hasn't dragged it back into the past.
    if (followLive) {
      const width = selTo - selFrom;
      selTo = Date.now();
      selFrom = selTo - width;
      layoutSeekWindow();
    }
    void refreshHistory();
  }, delay);
};

const refreshHistory = async (): Promise<void> => {
  let s: Series;
  try {
    s = (await fetch(`/api/history?from=${Math.round(selFrom)}&to=${Math.round(selTo)}&buckets=600`).then((r) =>
      r.json(),
    )) as Series;
  } catch (err) {
    console.error("[soltrk] history refresh failed", err);
    scheduleHistory(STATE_POLL_MS);
    return;
  }
  currentSeries = s;
  // Only the device/panel set forces a rebuild now - the seek bar changes
  // which span is fetched, not the shape of what's plotted, so a drag is
  // just new data for the same chart instances (see updateCharts).
  const key = `${s.devices.map((d) => d.sn).join(",")}:${s.panels.map((pn) => pn.name).join(",")}`;
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
  try {
    // Served from a once-a-minute cache, so asking on every state tick is
    // cheap even though it covers the whole record.
    renderSavings((await fetch("/api/energy").then((r) => r.json())) as Energy);
  } catch (err) {
    console.error("[soltrk] energy refresh failed", err);
  }
};

renderTabs();
void refreshState();
void refreshOverview();
void refreshHistory();
setInterval(() => void refreshState(), STATE_POLL_MS);
setInterval(() => void refreshOverview(), OVERVIEW_POLL_MS);
