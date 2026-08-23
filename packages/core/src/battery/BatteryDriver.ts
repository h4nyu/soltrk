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

export type BatteryDriver = {
  getStatus(sn: string): Promise<BatteryStatus | undefined>;
  // `acOn` is the allocator's AC-gate decision (see control/allocator.ts):
  // whether this device should be connected to AC at all this cycle.
  // Adapters without a physical gate (plain cloud drivers) just ignore it;
  // GatedBatteryDriver acts on it. Optional so those adapters' signatures
  // don't have to mention it.
  setChargeLimit(sn: string, watts: number, acOn?: boolean): Promise<boolean>;
};
