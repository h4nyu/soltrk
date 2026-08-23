import TuyAPI from "tuyapi";
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

export class SolarSource {
  private devices: TrackedDevice[] = [];

  constructor(private readonly configs: TuyaDeviceConfig[]) {}

  /**
   * Never throws for an unreachable device: a panel that can't be reached
   * right now (Wi-Fi flakiness, reboot, ...) is logged and retried in the
   * background every RECONNECT_INTERVAL_MS instead of killing the whole
   * loop - its readings are simply missing (and excluded from the total by
   * getTotalWatts's freshness check) until it comes back.
   */
  async connect(): Promise<void> {
    for (const cfg of this.configs) {
      const client = new TuyAPI({ id: cfg.id, key: cfg.key, ip: cfg.ip, version: "3.3" });
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

      this.devices.push(tracked);
      await this.tryConnect(tracked);
    }

    setInterval(() => {
      for (const d of this.devices) {
        if (!d.connected) void this.tryConnect(d);
      }
    }, RECONNECT_INTERVAL_MS);
  }

  private async tryConnect(tracked: TrackedDevice): Promise<void> {
    try {
      await tracked.client.connect();
      tracked.connected = true;
      console.log(`[tuya:${tracked.config.name}] connected at ${tracked.config.ip}`);
    } catch (err) {
      console.error(
        `[tuya:${tracked.config.name}] connect failed (will retry): ${(err as Error).message}`,
      );
    }
  }

  disconnect(): void {
    for (const d of this.devices) d.client.disconnect();
  }

  /** Sum of the latest known wattage across all panels; null entries (stale
   * or never-seen) are logged and excluded rather than treated as zero. */
  getTotalWatts(): number {
    const now = Date.now();
    let total = 0;
    for (const d of this.devices) {
      const fresh = d.lastWatts !== undefined && now - d.lastUpdatedAt < STALE_AFTER_MS;
      if (!fresh) {
        console.warn(`[tuya:${d.config.name}] no fresh reading - excluding from total`);
        continue;
      }
      total += d.lastWatts as number;
    }
    return total;
  }
}
