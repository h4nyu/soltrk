import { BatteryDriver, BatteryStatus } from "@soltrk/core";
import { AnkerDevice, AnkerSession, getBindDevices, getUserMqttInfo, login } from "./httpApi";
import { AnkerMqttSession } from "./mqttSession";
import { encodeRealtimeTrigger, encodeSetChargeLimit } from "./protocol";

const REALTIME_TRIGGER_TIMEOUT_SEC = 300;
const REALTIME_TRIGGER_RENEW_MS = 240_000;
// Only A1765 (SOLIX C1000X Gen 2) has a decoder wired up (see protocol.ts) -
// other models would need their own parseXParamInfo before being usable here.
const SUPPORTED_MODELS = new Set(["A1765"]);

/**
 * Native TypeScript Anker Solix client: login, MQTT session, and the A1765
 * read/write wire format are all implemented directly here rather than
 * proxied through the Python anker-driver service - see the session notes
 * for how each piece (ECDH+AES login, TLV command format) was reverse
 * engineered and cross-validated against real hardware.
 */
export class NativeAnkerClient implements BatteryDriver {
  private mqttSession?: AnkerMqttSession;
  private devicesBySn = new Map<string, AnkerDevice>();
  private readonly ready: Promise<void>;

  constructor(email: string, password: string, country: string) {
    this.ready = this.init(email, password, country).catch((err) => {
      console.error("[anker] initialization failed:", (err as Error).message);
      throw err;
    });
  }

  private async init(email: string, password: string, country: string): Promise<void> {
    const session: AnkerSession = await login(email, password, country);
    const devices = await getBindDevices(session);
    const supported = devices.filter((d) => SUPPORTED_MODELS.has(d.device_pn));
    for (const d of supported) this.devicesBySn.set(d.device_sn, d);
    if (supported.length === 0) {
      console.warn("[anker] no supported (A1765) devices found among", devices.length, "bound devices");
    }

    const mqttInfo = await getUserMqttInfo(session);
    this.mqttSession = new AnkerMqttSession(session, mqttInfo);
    await this.mqttSession.connect();
    for (const d of supported) this.mqttSession.subscribeDevice(d);

    this.startRealtimeTriggerLoop(supported);
  }

  private startRealtimeTriggerLoop(devices: AnkerDevice[]): void {
    const trigger = async () => {
      for (const d of devices) {
        try {
          await this.mqttSession?.publishCommand(d, encodeRealtimeTrigger(REALTIME_TRIGGER_TIMEOUT_SEC));
        } catch (err) {
          console.error(`[anker:${d.device_sn}] realtime_trigger failed:`, (err as Error).message);
        }
      }
    };
    void trigger();
    setInterval(trigger, REALTIME_TRIGGER_RENEW_MS);
  }

  async getStatus(sn: string): Promise<BatteryStatus | undefined> {
    try {
      await this.ready;
    } catch {
      return undefined;
    }
    const status = this.mqttSession?.getStatus(sn);
    return status
      ? {
          batterySoc: status.batterySoc,
          temperatureC: status.temperatureC,
          acInputWatts: status.acInputWatts,
          acOutputWatts: status.acOutputWatts,
        }
      : undefined;
  }

  async setChargeLimit(sn: string, watts: number): Promise<boolean> {
    try {
      await this.ready;
    } catch {
      return false;
    }
    const device = this.devicesBySn.get(sn);
    if (!device || !this.mqttSession) {
      console.error(`[anker:${sn}] unknown device or MQTT session not ready`);
      return false;
    }
    try {
      // watts=0 is the "stop charging" signal for deprioritized devices,
      // confirmed against the Anker app's displayed setting on real
      // hardware, same as every other 100W step (see README).
      await this.mqttSession.publishCommand(device, encodeSetChargeLimit(watts));
      return true;
    } catch (err) {
      console.error(`[anker:${sn}] set-charge-limit(${watts}) failed:`, (err as Error).message);
      return false;
    }
  }
}
