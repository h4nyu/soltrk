import TuyAPI from "tuyapi";
import { TuyaPlugConfig } from "./config";

/**
 * Controls a plain Tuya smart plug wired in series with a battery's AC
 * input cable - used as a hard on/off gate that doesn't depend on the
 * battery's own charge-limit command or TOU schedule, both of which have
 * proven unreliable for actually stopping AC charging (see the main
 * README). Connects fresh for each call rather than holding a persistent
 * connection: this is only invoked when the desired on/off state actually
 * changes (see GatedBatteryDriver in @soltrk/cli), not on every poll cycle.
 */
export class SmartPlug {
  constructor(private readonly config: TuyaPlugConfig) {}

  async setOn(on: boolean): Promise<boolean> {
    const client = new TuyAPI({
      id: this.config.id,
      key: this.config.key,
      ip: this.config.ip,
      version: "3.3",
    });
    try {
      await client.connect();
      await client.set({ dps: this.config.switchDp, set: on });
      return true;
    } catch (err) {
      console.error(`[tuya-plug:${this.config.id}] failed to set on=${on}:`, (err as Error).message);
      return false;
    } finally {
      client.disconnect();
    }
  }
}
