export interface AnkerStatus {
  battery_soc?: number;
  [key: string]: unknown;
}

export class AnkerClient {
  constructor(private readonly baseUrl: string) {}

  async getStatus(sn: string): Promise<AnkerStatus | undefined> {
    try {
      const res = await fetch(`${this.baseUrl}/devices/${sn}/status`);
      if (!res.ok) {
        console.error(`[anker:${sn}] status ${res.status}`);
        return undefined;
      }
      return (await res.json()) as AnkerStatus;
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
