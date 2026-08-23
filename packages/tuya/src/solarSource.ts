import TuyAPI from "tuyapi";
import { TuyaDeviceConfig } from "./config";

type TrackedDevice = {
  config: TuyaDeviceConfig;
  client: TuyAPI;
  lastWatts: number | undefined;
  lastUpdatedAt: number;
};

const STALE_AFTER_MS = 60_000;

export class SolarSource {
  private devices: TrackedDevice[] = [];

  constructor(private readonly configs: TuyaDeviceConfig[]) {}

  async connect(): Promise<void> {
    for (const cfg of this.configs) {
      const client = new TuyAPI({ id: cfg.id, key: cfg.key, ip: cfg.ip, version: "3.3" });
      const tracked: TrackedDevice = { config: cfg, client, lastWatts: undefined, lastUpdatedAt: 0 };

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

      await client.connect();
      this.devices.push(tracked);
      console.log(`[tuya:${cfg.name}] connected at ${cfg.ip}`);
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
