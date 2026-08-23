import { BatteryDriver, BatteryStatus, Result } from "@soltrk/core";
import { AnkerDevice, AnkerError, AnkerSession, getBindDevices, getUserMqttInfo, login } from "./httpApi";
import { AnkerMqttSession } from "./mqttSession";
import { encodeRealtimeTrigger, encodeSetChargeLimit } from "./protocol";

const REALTIME_TRIGGER_TIMEOUT_SEC = 300;
// Fallback wait for failures we can't parse a specific retry window out of
// (network errors, generic Anker throttling like code 26161) - deliberately
// long, since retrying fast is exactly what feeds Anker's sign-in lockout
// in the first place.
const DEFAULT_INIT_RETRY_MS = 15 * 60_000;
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
  // Flips true once init eventually succeeds; until then getStatus/
  // setChargeLimit just report "not available" instead of awaiting a
  // promise (awaiting would stall the whole control loop across however
  // many retry rounds a login outage lasts).
  private initialized = false;

  constructor(email: string, password: string, country: string) {
    void this.initWithRetry(email, password, country);
  }

  private async initWithRetry(email: string, password: string, country: string): Promise<void> {
    for (;;) {
      const result = await this.init(email, password, country);
      if (!(result instanceof Error)) {
        this.initialized = true;
        console.log("[anker] initialized");
        return;
      }
      // "account_locked" carries Anker's own stated lockout window (e.g.
      // "disabled for 9 minutes") - honor that exactly (plus a buffer
      // minute) instead of the generic fallback delay, since retrying
      // before it expires only re-triggers the lockout.
      const retryMs =
        "kind" in result && result.kind === "account_locked"
          ? (result.retryAfterMinutes + 1) * 60_000
          : DEFAULT_INIT_RETRY_MS;
      console.error(
        `[anker] initialization failed (retrying in ${Math.round(retryMs / 60_000)} min):`,
        result.message,
      );
      await new Promise((r) => setTimeout(r, retryMs));
    }
  }

  private async init(email: string, password: string, country: string): Promise<Result<void, AnkerError | Error>> {
    try {
      const session = await login(email, password, country);
      if (session instanceof Error) return session;

      const devices = await getBindDevices(session);
      if (devices instanceof Error) return devices;
      const supported = devices.filter((d) => SUPPORTED_MODELS.has(d.device_pn));
      for (const d of supported) this.devicesBySn.set(d.device_sn, d);
      if (supported.length === 0) {
        console.warn("[anker] no supported (A1765) devices found among", devices.length, "bound devices");
      }

      const mqttInfo = await getUserMqttInfo(session);
      if (mqttInfo instanceof Error) return mqttInfo;

      this.mqttSession = new AnkerMqttSession(session, mqttInfo);
      await this.mqttSession.connect();
      for (const d of supported) this.mqttSession.subscribeDevice(d);

      this.startRealtimeTriggerLoop(supported);
      return undefined;
    } catch (err) {
      // Fallback for anything below the httpApi layer (MQTT connect, etc.)
      // that still throws rather than returning a Result.
      return err instanceof Error ? err : new Error(String(err));
    }
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
    if (!this.initialized) return undefined;
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
    if (!this.initialized) return false;
    const device = this.devicesBySn.get(sn);
    if (!device || !this.mqttSession) {
      console.error(`[anker:${sn}] unknown device or MQTT session not ready`);
      return false;
    }
    try {
      // watts=0 is the "stop charging" signal for deprioritized devices,
      // but this alone doesn't guarantee it stops on real hardware: the
      // device's own TOU schedule is a separate layer that can keep
      // charging from AC regardless of what's requested here (see README).
      await this.mqttSession.publishCommand(device, encodeSetChargeLimit(watts));
      return true;
    } catch (err) {
      console.error(`[anker:${sn}] set-charge-limit(${watts}) failed:`, (err as Error).message);
      return false;
    }
  }
}
