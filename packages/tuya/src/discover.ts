import TuyAPI from "tuyapi";

/**
 * One-off helper to dump every dp (data point) a Tuya device reports, so you
 * can identify which dp code is instantaneous power and what scale it uses
 * before wiring it into data/tuya.json. Run inside the container via
 * `soltrk discover <id> <key>` (see packages/cli/src/index.ts).
 *
 * IP is resolved dynamically via UDP broadcast (find()) - this network's
 * devices don't have DHCP reservations, so a hardcoded IP would just go
 * stale. Requires network_mode: host (see docker-compose.yml).
 */
export async function discover(id: string, key: string): Promise<void> {
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
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      device.disconnect();
      resolve();
    }, 30_000);
  });
}
