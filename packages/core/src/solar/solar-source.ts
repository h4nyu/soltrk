/**
 * Vendor-neutral port for a source of instantaneous solar generation. The
 * control loop depends only on this, never on a concrete panel/inverter
 * client - see packages/tuya for the one adapter implementing it today.
 */
export type SolarSource = {
  connect(): Promise<void>;
  disconnect(): void;
  /** Latest known total watts across all panels; 0 if nothing fresh is known. */
  getTotalWatts(): number;
};
