/**
 * One-off helper to dump every dp (data point) a Tuya device reports, so you
 * can identify which dp code is instantaneous power and what scale it uses
 * before wiring it into config.ts. Run inside the container:
 *
 *   docker compose run --rm soltrk node dist/tuya/discover.js <id> <key> <ip>
 */
import TuyAPI from "tuyapi";

async function main() {
  const [id, key, ip] = process.argv.slice(2);
  if (!id || !key || !ip) {
    console.error("Usage: discover.js <id> <key> <ip>");
    process.exit(1);
  }
  const device = new TuyAPI({ id, key, ip, version: "3.3" });
  device.on("data", (data) => {
    console.log(new Date().toISOString(), JSON.stringify(data.dps));
  });
  device.on("error", (err) => console.error("error:", err.message));
  await device.connect();
  console.log("Connected. Watching dp updates for 30s (Ctrl+C to stop earlier)...");
  setTimeout(() => {
    device.disconnect();
    process.exit(0);
  }, 30_000);
}

main();
