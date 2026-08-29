import { Result } from "../result";

/**
 * Vendor-neutral port: business logic (the control loop, the allocator)
 * depends only on this type, never on a concrete vendor client. Adding
 * a new battery/charger brand means writing one adapter that implements
 * this and registering it in registry.ts - nothing else changes.
 */
export type BatteryStatus = {
  batterySoc?: number;
  // Optional telemetry a vendor adapter may not have - only batterySoc is
  // used for allocation decisions today, the rest is for status/logging.
  temperatureC?: number;
  acInputWatts?: number;
  acOutputWatts?: number;
};

/**
 * What a device should be doing with AC this cycle. Three states rather than
 * a simple on/off, because "connected to AC" and "charging" are separately
 * controllable on this hardware:
 *
 * The names say where the device's own household load is being fed from,
 * so they read directly off a log line:
 *
 * - `charge`      - on AC, and filling the battery too, at the requested
 *                   wattage. SOC rises. Costs a fixed ~33W conversion
 *                   overhead on top of what actually reaches the battery.
 * - `passthrough` - on AC, but *not* charging: the load is fed straight from
 *                   AC instead of from the battery, with no conversion
 *                   overhead at all (measured: AC in exactly equals AC out).
 *                   SOC holds level.
 * - `battery`     - disconnected from AC entirely, so the load runs off the
 *                   battery. SOC falls.
 *
 * An adapter with no way to stop charging or cut AC (a plain cloud driver)
 * can only approximate this - see each adapter for what it actually honors.
 */
export type AcMode = "charge" | "passthrough" | "battery";

export type BatteryDriver = {
  getStatus(sn: string): Promise<Result<BatteryStatus>>;
  // `mode` is the allocator's decision for this device this cycle (see
  // control/allocator.ts and AcMode above). Optional so adapters that can't
  // act on it don't have to mention it in their signature; `watts` is only
  // meaningful for `charge`.
  //
  // Returns the mode actually applied, which is not always the one asked
  // for: GatedBatteryDriver's discharge floor overrides `battery` with
  // `passthrough`. The caller records that rather than its own request, so
  // logs and state.json describe what the hardware was really told to do.
  setChargeLimit(sn: string, watts: number, mode?: AcMode): Promise<Result<AcMode>>;
};
