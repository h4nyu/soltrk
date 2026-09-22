/**
 * Vendor-neutral port for a source of instantaneous solar generation. The
 * control loop depends only on this, never on a concrete panel/inverter
 * client - see packages/tuya for the one adapter implementing it today.
 */
export type SolarSource = {
  connect(): Promise<void>;
  disconnect(): void;
  /**
   * Latest known watts per panel, keyed by its configured name. A panel is
   * simply absent from the result rather than present at 0 when it has
   * never reported anything, or when its reading has gone stale - see the
   * adapter for why a frozen old value is worse than nothing. The total
   * across all panels is this object's values summed, so there is exactly
   * one place (the adapter) deciding which readings are fresh enough to
   * count, rather than that judgment being duplicated between a total and
   * a breakdown and risking the two disagreeing.
   */
  getWattsByPanel(): Record<string, number>;
};
