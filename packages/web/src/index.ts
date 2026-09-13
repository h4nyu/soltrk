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
  // What a saved kilowatt-hour is worth. The figure that matters is the
  // marginal one - the per-kWh tariff rate plus the fuel adjustment and the
  // renewable levy - not the bill divided by its kWh, which folds in a
  // standing charge that generating does nothing to reduce.
  const yenPerKwh = Number(process.env.ELECTRICITY_PRICE_YEN_PER_KWH ?? 31);
  // Read from the same variable the control loop uses, so the dashboard cannot
  // quietly price against a different house than the loop is balancing for.
  const houseStandbyWatts = Number(process.env.HOUSE_STANDBY_WATTS ?? 70);

  const server = DashboardServer({ dataDir, distDir, retentionDays, yenPerKwh, houseStandbyWatts });
  await server.listen(port, host);
  console.log(`[web] listening on http://${host}:${port} (data=${dataDir}, dist=${distDir})`);
  console.log(`[web] pricing at ${yenPerKwh} yen/kWh against a ${houseStandbyWatts}W house`);
};

if (require.main === module) {
  main().catch((err: Error) => {
    console.error(`[web] fatal: ${err.message}`);
    process.exit(1);
  });
}
