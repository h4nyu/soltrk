import { BatteryDriver, BatteryStatus } from "../battery/BatteryDriver";

interface RawAnkerStatus {
  battery_soc?: number;
  [key: string]: unknown;
}

export class AnkerClient implements BatteryDriver {
  constructor(private readonly baseUrl: string) {}

  async getStatus(sn: string): Promise<BatteryStatus | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/devices/${sn}/status`);
      if (!res.ok) {
        console.error(`[anker:${sn}] status ${res.status}`);
        return undefined;
      }
      const raw = (await res.json()) as RawAnkerStatus;
      return { batterySoc: raw.battery_soc };
    } catch (err) {
      console.error(`[anker:${sn}] status request failed:`, (err as Error).message);
      return undefined;
    }
  }

  async setChargeLimit(sn: string, watts: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/devices/${sn}/charge-limit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ watts }),
      });
      if (!res.ok) {
        console.error(`[anker:${sn}] set-charge-limit(${watts}) -> ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[anker:${sn}] set-charge-limit request failed:`, (err as Error).message);
      return false;
    }
  }
}
