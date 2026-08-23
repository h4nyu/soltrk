import TuyAPI from "tuyapi";
import { SolarSource as IF } from "@soltrk/core";
import { TuyaDeviceConfig } from "./config";

type TrackedDevice = {
  config: TuyaDeviceConfig;
  client: TuyAPI;
  connected: boolean;
  lastWatts: number | undefined;
  lastUpdatedAt: number;
};

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
 * freshness check) until it comes back.
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
        lastWatts: undefined,
        lastUpdatedAt: 0,
      };

      client.on("data", (data) => {
        const raw = data.dps?.[cfg.powerDp];
        if (typeof raw === "number") {
          tracked.lastWatts = raw / cfg.powerScale;
          tracked.lastUpdatedAt = Date.now();
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
      for (const d of devices) {
        if (!d.connected) void tryConnect(d);
      }
    }, RECONNECT_INTERVAL_MS);
  };

  const disconnect: IF["disconnect"] = () => {
    for (const d of devices) d.client.disconnect();
  };

  /** Sum of the latest known wattage across all panels; null entries (stale
   * or never-seen) are logged and excluded rather than treated as zero. */
  const getTotalWatts: IF["getTotalWatts"] = () => {
    const now = Date.now();
    let total = 0;
    for (const d of devices) {
      const fresh = d.lastWatts !== undefined && now - d.lastUpdatedAt < STALE_AFTER_MS;
      if (!fresh) {
        console.warn(`[tuya:${d.config.name}] no fresh reading - excluding from total`);
        continue;
      }
      total += d.lastWatts as number;
    }
    return total;
  };

  return { connect, disconnect, getTotalWatts };
};
