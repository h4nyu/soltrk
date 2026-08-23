/**
 * Vendor-neutral port: business logic (the control loop, the allocator)
 * depends only on this interface, never on a concrete vendor client. Adding
 * a new battery/charger brand means writing one adapter that implements
 * this and registering it in registry.ts - nothing else changes.
 */
export interface BatteryStatus {
  batterySoc?: number;
}

export interface BatteryDriver {
  getStatus(sn: string): Promise<BatteryStatus | undefined>;
  setChargeLimit(sn: string, watts: number): Promise<boolean>;
}
