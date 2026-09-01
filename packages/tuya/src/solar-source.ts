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
  // Asks the device for a fresh reading. Assigned per device in connect(),
  // where the config and client are in scope.
  refresh?: () => Promise<void>;
};

// How often to ask each device for its current reading. **These devices do
// not push on their own** - that has to be said plainly, because the code
// here used to assume they did and the assumption survived a long time by
// looking exactly like a working one. There was no `get()` anywhere: the
// only thing that ever produced a reading was the response to `connect()`.
// With the stale threshold at 60s and the reconnect check every 30s, every
// device was being torn down and reconnected roughly every 90 seconds, and
// each reconnect fetched one value. The reconnect loop *was* the poller,
// and the "90 second push cadence" measured off the logs was really the
// reconnect cadence measuring itself.
//
// The tell came from raising the stale threshold to 210s to stop what
// looked like needless reconnects: the reading interval immediately became
// 214s. Readings tracked the threshold exactly, because they were caused by
// it.
//
// So ask explicitly, and let the connection stay up. 30s matches the
// control loop, so a cycle rarely acts on a figure more than one interval
// old.
const REFRESH_INTERVAL_MS = 30_000;
// Zombie-connection detection, which only means anything now that something
// is actually asking: four refreshes have gone unanswered on a connection
// that still claims to be up.
const STALE_AFTER_MS = 120_000;
const RECONNECT_INTERVAL_MS = 30_000;
// How long to listen for the device's UDP broadcast before giving up on
// resolving its current IP for this attempt (see tryConnect).
const FIND_TIMEOUT_SEC = 10;

// Observed live: a GTB-800 sitting in direct summer sun can suddenly report
// almost exactly half its immediately-prior reading, then recover minutes
// later - consistent with the panel's own thermal protection halving
// output rather than a connectivity blip (which reads as 0/missing, not a
// clean fraction). Only checked above THERMAL_WATCH_MIN_WATTS so dawn/dusk
// noise near zero doesn't produce meaningless ratios. This can't distinguish
// a real thermal event from a sudden cloud passing overhead - both look
// like the same kind of drop - so treat the log line as "worth a look", not
// a confirmed diagnosis.
const THERMAL_HALVING_RATIO_MIN = 0.4;
const THERMAL_HALVING_RATIO_MAX = 0.6;
const THERMAL_WATCH_MIN_WATTS = 50;

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

      // Shared by both paths that can produce a reading: the reply to our
      // own `get()`, and any unsolicited "data" the device happens to emit.
      // Both are welcome; whichever arrives first wins and the other is a
      // no-op, since an identical value re-applied changes nothing and its
      // thermal ratio is 1.0.
      const applyReading = (dps: Record<string, unknown> | undefined): void => {
        const raw = dps?.[cfg.powerDp];
        if (typeof raw !== "number") return;
        const newWatts = raw / cfg.powerScale;
        const prevWatts = tracked.lastWatts;
        if (prevWatts !== undefined && prevWatts >= THERMAL_WATCH_MIN_WATTS) {
          const ratio = newWatts / prevWatts;
          if (ratio >= THERMAL_HALVING_RATIO_MIN && ratio <= THERMAL_HALVING_RATIO_MAX) {
            console.warn(
              `[tuya:${cfg.name}] output dropped to ${(ratio * 100).toFixed(0)}% of its previous ` +
                `reading (${prevWatts.toFixed(1)}W -> ${newWatts.toFixed(1)}W) - possible thermal throttle`,
            );
          }
        }
        // The timestamp moves on every reading, the log line only when the
        // value does: at a 30s refresh an unchanged figure is the common
        // case and logging it would bury everything else.
        const changed = newWatts !== prevWatts;
        tracked.lastWatts = newWatts;
        tracked.lastUpdatedAt = Date.now();
        if (changed) console.log(`[tuya:${cfg.name}] ${newWatts.toFixed(1)}W`);
      };
      tracked.refresh = async (): Promise<void> => {
        try {
          const res = (await client.get({ schema: true })) as {
            dps?: Record<string, unknown>;
          };
          applyReading(res?.dps);
        } catch (err) {
          // Left to the zombie check rather than reconnecting here: one
          // failed request is not evidence the connection is gone, and
          // tearing it down costs a reconnect before anything can be read.
          console.error(`[tuya:${cfg.name}] refresh failed: ${(err as Error).message}`);
        }
      };

      client.on("data", (data) => applyReading(data.dps));
      client.on("error", (err) => {
        console.error(`[tuya:${cfg.name}] error:`, err.message);
      });
      client.on("disconnected", () => {
        tracked.connected = false;
      });

      devices.push(tracked);
      await tryConnect(tracked);
      void tracked.refresh?.();
    }

    setInterval(() => {
      for (const d of devices) if (d.connected) void d.refresh?.();
    }, REFRESH_INTERVAL_MS);

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
            `[tuya:${d.config.name}] no answer to ${Math.round(STALE_AFTER_MS / REFRESH_INTERVAL_MS)} refreshes ` +
              `(${Math.round((now - d.lastUpdatedAt) / 1000)}s) - forcing reconnect`,
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
