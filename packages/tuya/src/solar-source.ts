import TuyAPI from "tuyapi";
import { SolarSource as IF } from "@soltrk/core";
import { TuyaDeviceConfig } from "./config";

type TrackedDevice = {
  config: TuyaDeviceConfig;
  client: TuyAPI;
  connected: boolean;
  connectedAt: number;
  lastWatts: number | undefined;
  lastUpdatedAt: number;
};

// Used for zombie-connection detection (see the reconnect loop below) - a
// tight window so a genuinely stuck socket gets kicked promptly.
const STALE_AFTER_MS = 60_000;
const RECONNECT_INTERVAL_MS = 30_000;
// How long to listen for the device's UDP broadcast before giving up on
// resolving its current IP for this attempt (see tryConnect).
const FIND_TIMEOUT_SEC = 10;

/**
 * Implements @soltrk/core's SolarSource port for the two GTB-800
 * microinverters, read over the Tuya *local* protocol (no cloud). Never
 * throws for an unreachable device: a panel that can't be reached right
 * now (Wi-Fi flakiness, reboot, the panel's own inverter being unpowered
 * overnight...) is logged and retried in the background every
 * RECONNECT_INTERVAL_MS instead of killing the whole loop - its readings
 * are simply missing (and excluded from the total by getTotalWatts's
 * freshness check) until it comes back. A device stuck reporting
 * `connected` while its data has actually gone stale (a zombie socket with
 * no clean disconnect event) is detected the same way and forced through a
 * fresh reconnect rather than sitting there forever.
 */
export const SolarSource = (props: { configs: TuyaDeviceConfig[] }): IF => {
  const { configs } = props;
  const devices: TrackedDevice[] = [];

  const tryConnect = async (tracked: TrackedDevice): Promise<void> => {
    try {
      // No IP is configured - these devices don't have DHCP reservations
      // and their IPs drift, so it's resolved fresh via UDP broadcast on
      // every (re)connect attempt rather than trusted from a stale config
      // value. Requires network_mode: host (see docker-compose.yml) -
      // Docker's default bridge network doesn't deliver broadcast packets
      // into the container at all.
      await tracked.client.find({ timeout: FIND_TIMEOUT_SEC });
      await tracked.client.connect();
      tracked.connected = true;
      tracked.connectedAt = Date.now();
      console.log(`[tuya:${tracked.config.name}] connected`);
    } catch (err) {
      console.error(
        `[tuya:${tracked.config.name}] connect failed (will retry): ${(err as Error).message}`,
      );
    }
  };

  const connect: IF["connect"] = async () => {
    for (const cfg of configs) {
      const client = new TuyAPI({ id: cfg.id, key: cfg.key, version: "3.3" });
      const tracked: TrackedDevice = {
        config: cfg,
        client,
        connected: false,
        connectedAt: 0,
        lastWatts: undefined,
        lastUpdatedAt: 0,
      };

      client.on("data", (data) => {
        const raw = data.dps?.[cfg.powerDp];
        if (typeof raw === "number") {
          tracked.lastWatts = raw / cfg.powerScale;
          tracked.lastUpdatedAt = Date.now();
          console.log(`[tuya:${cfg.name}] ${tracked.lastWatts.toFixed(1)}W`);
        }
      });
      client.on("error", (err) => {
        console.error(`[tuya:${cfg.name}] error:`, err.message);
      });
      client.on("disconnected", () => {
        tracked.connected = false;
      });

      devices.push(tracked);
      await tryConnect(tracked);
    }

    setInterval(() => {
      const now = Date.now();
      for (const d of devices) {
        // A device can end up "connected" per the client's own bookkeeping
        // while its socket has silently stopped delivering data (no clean
        // "disconnected" event fires for that) - treat long-stale data on an
        // otherwise-connected device as a zombie and force it through a
        // fresh reconnect rather than waiting forever for an event that
        // isn't coming. The connectedAt guard avoids flagging a device
        // that's simply still waiting for its first push right after
        // connecting.
        const zombie =
          d.connected &&
          now - d.connectedAt >= STALE_AFTER_MS &&
          now - d.lastUpdatedAt >= STALE_AFTER_MS;
        if (zombie) {
          console.warn(
            `[tuya:${d.config.name}] connected but no data for ${Math.round((now - d.lastUpdatedAt) / 1000)}s - forcing reconnect`,
          );
          d.client.disconnect();
          d.connected = false;
        }
        if (!d.connected) void tryConnect(d);
      }
    }, RECONNECT_INTERVAL_MS);
  };

  const disconnect: IF["disconnect"] = () => {
    for (const d of devices) d.client.disconnect();
  };

  /** Sum of the latest known wattage across all panels. A panel that's gone
   * stale keeps contributing its last known reading rather than dropping to
   * zero - solar output moves gradually (observed: roughly an hour from 0
   * to peak), so a stale-but-recent reading is a far better estimate than
   * zero during a connectivity blip, and it's overwritten the instant a
   * fresh reading arrives anyway. Only a panel that has never reported
   * anything at all (no reading to fall back on) contributes 0 - logged
   * once so a permanently-unreachable panel is still visible somewhere,
   * even though it no longer affects the total once it has ever reported. */
  const getTotalWatts: IF["getTotalWatts"] = () => {
    let total = 0;
    for (const d of devices) {
      if (d.lastWatts === undefined) {
        console.warn(`[tuya:${d.config.name}] no reading yet - excluding from total`);
        continue;
      }
      total += d.lastWatts;
    }
    return total;
  };

  return { connect, disconnect, getTotalWatts };
};
