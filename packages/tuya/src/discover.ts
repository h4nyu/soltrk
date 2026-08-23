/**
 * One-off helper to dump every dp (data point) a Tuya device reports, so you
 * can identify which dp code is instantaneous power and what scale it uses
 * before wiring it into .env. Run inside the container:
 *
 *   docker compose run --rm soltrk npx tsx packages/tuya/src/discover.ts <id> <key>
 *
 * IP is resolved dynamically via UDP broadcast (find()) - this network's
 * devices don't have DHCP reservations, so a hardcoded IP would just go
 * stale. Requires network_mode: host (see docker-compose.yml).
 */
import TuyAPI from "tuyapi";

async function main() {
  const [id, key] = process.argv.slice(2);
  if (!id || !key) {
    console.error("Usage: discover.js <id> <key>");
    process.exit(1);
  }
  const device = new TuyAPI({ id, key, version: "3.3" });
  device.on("data", (data) => {
    console.log(new Date().toISOString(), JSON.stringify(data.dps));
  });
  device.on("error", (err) => console.error("error:", err.message));
  console.log("Resolving IP via UDP broadcast...");
  await device.find({ timeout: 10 });
  await device.connect();
  // Some devices (e.g. plain smart plugs) only report dps on explicit
  // request, not proactively on every state change - request the current
  // snapshot immediately so a device that never pushes still shows something.
  try {
    const initial = await device.get({ schema: true });
    console.log(new Date().toISOString(), "(initial get)", JSON.stringify(initial));
  } catch (err) {
    console.error("initial get failed:", (err as Error).message);
  }
  console.log("Connected. Watching dp updates for 30s (Ctrl+C to stop earlier)...");
  setTimeout(() => {
    device.disconnect();
    process.exit(0);
  }, 30_000);
}

main();
