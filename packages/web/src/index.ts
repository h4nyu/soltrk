import { resolve } from "node:path";
import { DashboardServer } from "./server";

export { DashboardServer } from "./server";
export { HistoryStore } from "./history";
export type { DeviceMeta, Series } from "./history";

/**
 * Entrypoint for the `web` compose service. Deliberately its own process and
 * its own image: rebuilding the dashboard must never restart the control loop,
 * because every loop restart is a fresh Anker cloud login and this repo has
 * already tripped that account's sign-in lockout by restarting too often.
 */
const main = async (): Promise<void> => {
  const port = Number(process.env.WEB_PORT ?? 8080);
  const host = process.env.WEB_HOST ?? "0.0.0.0";
  const dataDir = process.env.DATA_DIR ?? "./data";
  const distDir = process.env.WEB_DIST_DIR ?? resolve(__dirname, "..", "dist");
  const retentionDays = Number(process.env.WEB_RETENTION_DAYS ?? 30);

  const server = DashboardServer({ dataDir, distDir, retentionDays });
  await server.listen(port, host);
  console.log(`[web] listening on http://${host}:${port} (data=${dataDir}, dist=${distDir})`);
};

if (require.main === module) {
  main().catch((err: Error) => {
    console.error(`[web] fatal: ${err.message}`);
    process.exit(1);
  });
}
