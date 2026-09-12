import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { SeriesBuilder } from "./buckets";
import { HistoryStore } from "./history";
import { SummaryStore } from "./summaries";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const HOUR_MS = 3_600_000;

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // The dashboard polls; never let a proxy or the browser hold a stale cycle.
    "cache-control": "no-store",
  });
  res.end(text);
};

/**
 * Read-only dashboard server for the control loop's own output.
 *
 * It never imports an adapter and never opens a device connection: everything
 * it shows comes from files the loop already writes (data/state.json for the
 * current cycle, data/history.jsonl for the past). That is the whole point of
 * running it as its own container - it can be rebuilt and restarted freely
 * while the loop keeps running, with no Anker cloud login and no interruption
 * to household power.
 */
export const DashboardServer = (props: {
  dataDir: string;
  distDir: string;
  retentionDays?: number;
}) => {
  const history = HistoryStore({
    dataDir: props.dataDir,
    retentionDays: props.retentionDays,
  });
  // Anything older than the raw window comes from the monthly summaries that
  // `soltrk summarize` leaves behind after deleting the raw days.
  const summaries = SummaryStore({ dataDir: props.dataDir });
  const distRoot = resolve(props.distDir);

  const serveStatic = async (urlPath: string, res: ServerResponse): Promise<void> => {
    const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
    const file = resolve(join(distRoot, rel));
    if (file !== distRoot && !file.startsWith(distRoot + sep)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      // Unknown path: hand back the app shell so the client can render its own
      // "not found", rather than a bare 404 from node.
      try {
        const shell = await readFile(join(distRoot, "index.html"));
        res.writeHead(200, { "content-type": MIME[".html"] }).end(shell);
      } catch {
        res.writeHead(404).end("not built - run `npm run build` in packages/web");
      }
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/api/state") {
      try {
        const raw = await readFile(join(props.dataDir, "state.json"), "utf8");
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(raw);
      } catch (err) {
        sendJson(res, 503, { error: (err as Error).message });
      }
      return;
    }

    if (url.pathname === "/api/history") {
      const refreshed = await history.refresh();
      if (refreshed instanceof Error) {
        sendJson(res, 503, { error: refreshed.message });
        return;
      }
      await summaries.refresh();

      const raw = history.span();
      const rolled = summaries.span();
      const available =
        raw && rolled
          ? { from: Math.min(raw.from, rolled.from), to: Math.max(raw.to, rolled.to) }
          : (raw ?? rolled);

      const to = Number(url.searchParams.get("to")) || available?.to || Date.now();
      const hours = Number(url.searchParams.get("hours")) || 24;
      const from = Number(url.searchParams.get("from")) || to - hours * HOUR_MS;
      const buckets = Math.min(2000, Math.max(10, Number(url.searchParams.get("buckets")) || 500));

      const builder = SeriesBuilder({ from, to, buckets });
      history.contribute(builder);
      // The raw log wins wherever it reaches; summaries fill in before that,
      // so no cycle is counted from both sources.
      summaries.contribute(builder, raw?.from ?? Number.POSITIVE_INFINITY);

      sendJson(res, 200, {
        ...builder.finish(),
        available: available ?? null,
        sampleCount: history.sampleCount(),
        rawFrom: raw?.from ?? null,
        months: summaries.months(),
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end("method not allowed");
      return;
    }
    await serveStatic(url.pathname, res);
  };

  const server = createHttpServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      console.error(`[web] ${req.method} ${req.url} failed: ${err.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
      else res.end();
    });
  });

  return {
    listen: (port: number, host: string): Promise<void> =>
      new Promise((done) => server.listen(port, host, () => done())),
    close: (): Promise<void> => new Promise((done) => server.close(() => done())),
  };
};
