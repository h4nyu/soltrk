import { BatteryDriver, Result } from "@soltrk/core";
import { AnkerDevice, AnkerError, getBindDevices, getUserMqttInfo, login } from "./http-api";
import { AnkerMqttSession } from "./mqtt-session";
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
export const NativeAnkerClient = (props: { email: string; password: string; country: string }): BatteryDriver => {
  const { email, password, country } = props;
  let mqttSession: AnkerMqttSession | undefined;
  const devicesBySn = new Map<string, AnkerDevice>();
  // Flips true once init eventually succeeds; until then getStatus/
  // setChargeLimit just report "not available" instead of awaiting a
  // promise (awaiting would stall the whole control loop across however
  // many retry rounds a login outage lasts).
  let initialized = false;

  const init = async (): Promise<Result<void, AnkerError | Error>> => {
    try {
      const session = await login(email, password, country);
      if (Result.isErr(session)) return session;

      const devices = await getBindDevices(session);
      if (Result.isErr(devices)) return devices;
      const supported = devices.filter((d) => SUPPORTED_MODELS.has(d.device_pn));
      for (const d of supported) devicesBySn.set(d.device_sn, d);
      if (supported.length === 0) {
        console.warn("[anker] no supported (A1765) devices found among", devices.length, "bound devices");
      }

      const mqttInfo = await getUserMqttInfo(session);
      if (Result.isErr(mqttInfo)) return mqttInfo;

      mqttSession = new AnkerMqttSession(session, mqttInfo);
      await mqttSession.connect();
      for (const d of supported) mqttSession.subscribeDevice(d);

      startRealtimeTriggerLoop(supported);
      return undefined;
    } catch (err) {
      // Fallback for anything below the httpApi layer (MQTT connect, etc.)
      // that still throws rather than returning a Result.
      return err instanceof Error ? err : new Error(String(err));
    }
  };

  const initWithRetry = async (): Promise<void> => {
    for (;;) {
      const result = await init();
      if (Result.isOk(result)) {
        initialized = true;
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
  };

  const startRealtimeTriggerLoop = (devices: AnkerDevice[]): void => {
    const trigger = async () => {
      for (const d of devices) {
        try {
          await mqttSession?.publishCommand(d, encodeRealtimeTrigger(REALTIME_TRIGGER_TIMEOUT_SEC));
        } catch (err) {
          console.error(`[anker:${d.device_sn}] realtime_trigger failed:`, (err as Error).message);
        }
      }
    };
    void trigger();
    setInterval(trigger, REALTIME_TRIGGER_RENEW_MS);
  };

  void initWithRetry();

  const getStatus: BatteryDriver["getStatus"] = async (sn) => {
    if (!initialized) return new Error(`[anker:${sn}] not initialized yet`);
    const status = mqttSession?.getStatus(sn);
    if (!status) return new Error(`[anker:${sn}] no status received yet`);
    return {
      batterySoc: status.batterySoc,
      temperatureC: status.temperatureC,
      acInputWatts: status.acInputWatts,
      acOutputWatts: status.acOutputWatts,
    };
  };

  const setChargeLimit: BatteryDriver["setChargeLimit"] = async (sn, watts) => {
    if (!initialized) return new Error(`[anker:${sn}] not initialized yet`);
    const device = devicesBySn.get(sn);
    if (!device || !mqttSession) {
      const message = `[anker:${sn}] unknown device or MQTT session not ready`;
      console.error(message);
      return new Error(message);
    }
    try {
      // watts=0 is the "stop charging" signal for deprioritized devices,
      // but this alone doesn't guarantee it stops on real hardware: the
      // device's own TOU schedule is a separate layer that can keep
      // charging from AC regardless of what's requested here (see README).
      await mqttSession.publishCommand(device, encodeSetChargeLimit(watts));
      return undefined;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[anker:${sn}] set-charge-limit(${watts}) failed:`, error.message);
      return error;
    }
  };

  return { getStatus, setChargeLimit };
};
