import { BatteryDriver, BatteryStatus, Result } from "@soltrk/core";
import { TuyaPlugConfig, SmartPlug } from "@soltrk/tuya";

// Minimal shape the gated driver needs from a plug - lets tests inject a
// fake instead of a real smart plug (which opens a TCP connection on every
// setOn() call).
export type PowerGate = { setOn(on: boolean): Promise<Result<void>> };

export function gatesBySn(plugs: TuyaPlugConfig[]): Map<string, PowerGate> {
  return new Map(plugs.map((plug) => [plug.gatesSn, SmartPlug({ config: plug })]));
}

/**
 * Wraps a BatteryDriver with physical Tuya smart plugs wired in series with
 * a gated battery's AC input cable - a hard on/off cutoff that doesn't
 * depend on the Anker device's own charge-limit command or TOU schedule,
 * both of which have proven unreliable for actually stopping AC charging
 * (see the main README's "Known caveats"). A battery with no plug
 * configured for its sn just passes through to `inner` unchanged, so this
 * can wrap every Anker device and only the ones with a
 * TUYA_PLUG_*_GATES_SN entry actually get gated.
 *
 * The plug follows the allocator's `mode` decision (see
 * @soltrk/core/control/allocator.ts and AcMode): closed for `charge` and
 * `passthrough`, open for `battery`. When `mode` isn't provided (a caller
 * not using the allocator), it falls back to inferring from the wattage: on
 * only when more than `offWatts` (the allocator's `chargeLimitMin`, what
 * deprioritized devices are sent) was requested.
 *
 * Discharge floor: unlike a plain "anker" device, a gated one can be cut
 * off from AC entirely (no solar, not the charging pick) with nothing to
 * stop its own battery draining to zero powering whatever it's plugged into
 * (e.g. an actual refrigerator). So below `dischargeFloorSocPercent`, this
 * driver simply stops letting it run on its battery: `battery` is replaced
 * with `passthrough`, feeding the device's load from AC instead. An SOC that
 * can't be read counts as below the floor, since the failure that matters is
 * draining a battery nobody can see.
 *
 * That is all the floor does - it takes `battery` off the table, it does not
 * pin the device to `passthrough`. `charge` still passes straight through,
 * and is in fact the only thing that moves the SOC back up: passthrough
 * holds it level, so a device below the floor sits there until the
 * allocator picks it as a charging target once there's solar for it. The
 * cycle reads floor -> passthrough (stop draining) -> charge (SOC recovers)
 * -> discharging allowed again as soon as it's back above the floor.
 *
 * Passthrough rather than a forced charge is the point: it costs only the
 * device's own load off the grid, with no ~33W conversion overhead and
 * nothing bought to push into the battery.
 *
 * There's deliberately no second, higher threshold to release at: the
 * condition is just "is it above the floor", evaluated fresh each cycle
 * from the current SOC, with no memory of which side it came from.
 * Hysteresis would normally guard against flapping at the line, but there's
 * very little to flap here - passthrough holds SOC level rather than
 * raising it, so a device that hits the floor stays put until something
 * actually charges it, which only happens when there's solar to spare. The
 * physical `plug.setOn()` call itself is only made
 * when the desired state actually differs from the last one successfully
 * applied (`lastGateBySn`) - every physical plug in this project shares the
 * same LAN with the GTB-800 solar readings, which are known to time out
 * transiently, so calling it needlessly on every cycle just adds exposure
 * to that flakiness for no behavioral difference. `inner.setChargeLimit`
 * (the wattage itself) is still sent every cycle the gate is on, since the
 * allocator's requested watts changes cycle to cycle even while the gate
 * stays open.
 */
export const GatedBatteryDriver = (props: {
  inner: BatteryDriver;
  plugsBySn: Map<string, PowerGate>;
  offWatts: number;
  dischargeFloorSocPercent: number;
}): BatteryDriver => {
  const { inner, plugsBySn, offWatts, dischargeFloorSocPercent } = props;
  const lastGateBySn = new Map<string, boolean>();

  const getStatus: BatteryDriver["getStatus"] = (sn) => inner.getStatus(sn);

  const setChargeLimit: BatteryDriver["setChargeLimit"] = async (sn, watts, mode) => {
    const plug = plugsBySn.get(sn);
    if (!plug) return inner.setChargeLimit(sn, watts, mode);

    const status = await inner.getStatus(sn);
    const soc = Result.isErr(status) ? undefined : status.batterySoc;
    // An unreadable SOC counts as below the floor. The two ways of being
    // wrong aren't equally bad: treating a full battery as empty costs a
    // cycle of passthrough, which holds SOC level and buys the device's own
    // load off the grid, while treating an empty one as fine keeps
    // discharging it with the physical cutoff open and nothing left to stop
    // it. Seen live - every restart's first cycle reports no SOC yet, and
    // put all three units back on their batteries at 6-10%.
    const belowFloor = soc === undefined || soc <= dischargeFloorSocPercent;
    if (belowFloor) {
      console.warn(
        soc === undefined
          ? `[gated:${sn}] SOC unknown - on AC instead of its battery until it reads again`
          : `[gated:${sn}] SOC ${soc}% is at or below the ${dischargeFloorSocPercent}% discharge floor - on AC instead of its battery`,
      );
    }

    // Below the floor, `battery` becomes `passthrough` - that's the whole
    // override. `charge` is left alone: it's better than passthrough here
    // (it refills rather than just holding) and it's the only way back up.
    const effectiveMode =
      belowFloor && mode !== "charge" ? "passthrough" : (mode ?? (watts > offWatts ? "charge" : "battery"));

    const gateOn = effectiveMode !== "battery";
    if (lastGateBySn.get(sn) !== gateOn) {
      const gateResult = await plug.setOn(gateOn);
      if (Result.isErr(gateResult)) return gateResult;
      lastGateBySn.set(sn, gateOn);
    }
    if (!gateOn) return "battery";
    const result = await inner.setChargeLimit(sn, watts, effectiveMode);
    // Report the mode this driver decided on, not whatever the inner adapter
    // makes of it - the floor override above is this layer's call, and it's
    // what the plug was actually switched to.
    return Result.isErr(result) ? result : effectiveMode;
  };

  return { getStatus, setChargeLimit };
};
