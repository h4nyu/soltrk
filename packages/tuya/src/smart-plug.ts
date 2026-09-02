import TuyAPI from "tuyapi";
import { Result } from "@soltrk/core";
import { TuyaPlugConfig } from "./config";

// How long to listen for the device's UDP broadcast before giving up on
// resolving its current IP for this call.
const FIND_TIMEOUT_SEC = 10;
// A single find()/connect() round can time out transiently on this network
// (observed live, same LAN flakiness as the GTB-800 solar readings) - retry
// a couple of times within the same call rather than giving up and losing
// a full poll cycle's worth of gating, since the caller (GatedBatteryDriver)
// treats any failure here as "the AC state didn't change" and skips its own
// charge-limit command for the cycle too.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Controls a plain Tuya smart plug wired in series with a battery's AC
 * input cable - used as a hard on/off gate that doesn't depend on the
 * battery's own charge-limit command or TOU schedule, both of which have
 * proven unreliable for actually stopping AC charging (see the main
 * README). Connects fresh for each call rather than holding a persistent
 * connection. GatedBatteryDriver only calls this when the desired on/off
 * state actually changes, not on every poll cycle - but a single call can
 * still fail transiently, hence the retries below.
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

  const attemptOnce = async (on: boolean): Promise<Result<void>> => {
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
      // A resolved set() isn't proof the relay actually flipped: tuyapi can
      // resolve it off a bare protocol ack or an empty DP_REFRESH packet
      // (its own source calls this "always empty") without ever reporting
      // the device's real post-set state - observed live, the promise
      // resolved cleanly while the physical plug stayed in its old state
      // for hours. Explicitly re-read the dp so a silently-ignored command
      // surfaces as a real error (and gets retried below) instead of a
      // false "success" the caller then trusts indefinitely.
      const status = (await client.get({ schema: true })) as { dps?: Record<string, unknown> };
      const actual = status.dps?.[config.switchDp];
      if (actual !== on) {
        return new Error(
          `set(on=${on}) was acked but device now reports dp ${config.switchDp}=${JSON.stringify(actual)}`,
        );
      }
      return undefined;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    } finally {
      client.disconnect();
    }
  };

  const setOn = async (on: boolean): Promise<Result<void>> => {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await attemptOnce(on);
      if (Result.isOk(result)) return undefined;
      lastError = result;
      console.error(
        `[tuya-plug:${config.id}] failed to set on=${on} (attempt ${attempt}/${MAX_ATTEMPTS}):`,
        result.message,
      );
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
    return lastError as Error;
  };

  return { setOn };
};
