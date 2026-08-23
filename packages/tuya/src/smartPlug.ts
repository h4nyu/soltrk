import TuyAPI from "tuyapi";
import { Result } from "@soltrk/core";
import { TuyaPlugConfig } from "./config";

// How long to listen for the device's UDP broadcast before giving up on
// resolving its current IP for this call.
const FIND_TIMEOUT_SEC = 10;

/**
 * Controls a plain Tuya smart plug wired in series with a battery's AC
 * input cable - used as a hard on/off gate that doesn't depend on the
 * battery's own charge-limit command or TOU schedule, both of which have
 * proven unreliable for actually stopping AC charging (see the main
 * README). Connects fresh for each call rather than holding a persistent
 * connection: this is only invoked when the desired on/off state actually
 * changes (see GatedBatteryDriver in @soltrk/cli), not on every poll cycle.
 *
 * No IP is configured - this network's devices don't have DHCP
 * reservations and their IPs drift, so it's resolved fresh via UDP
 * broadcast (tuyapi's find()) on every call rather than trusted from a
 * stale config value. Requires network_mode: host (see docker-compose.yml)
 * - Docker's default bridge network doesn't deliver broadcast packets into
 * the container at all.
 */
export const SmartPlug = (props: { config: TuyaPlugConfig }) => {
  const { config } = props;

  const setOn = async (on: boolean): Promise<Result<void>> => {
    const client = new TuyAPI({ id: config.id, key: config.key, version: "3.3" });
    // Without a listener, tuyapi's async "error" events (e.g. a timeout
    // emitted outside the awaited connect()/set() promise chain) are
    // *unhandled* EventEmitter errors and crash the whole process -
    // observed live killing the loop. The awaited calls below still
    // reject on failure; this listener just keeps out-of-band errors
    // non-fatal.
    client.on("error", (err) => {
      console.error(`[tuya-plug:${config.id}] error:`, err.message);
    });
    try {
      await client.find({ timeout: FIND_TIMEOUT_SEC });
      await client.connect();
      await client.set({ dps: config.switchDp, set: on });
      return undefined;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[tuya-plug:${config.id}] failed to set on=${on}:`, error.message);
      return error;
    } finally {
      client.disconnect();
    }
  };

  return { setOn };
};
