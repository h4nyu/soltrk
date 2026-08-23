function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export type TuyaDeviceConfig = {
  name: string;
  id: string;
  key: string;
  ip: string;
  powerDp: string;
  // Raw Tuya dp value is divided by this to get Watts (Tuya often reports
  // power in tenths of a watt). Confirm the right value for your device
  // with `npm run tuya:discover` before trusting the numbers.
  powerScale: number;
};

export function loadTuyaDevices(): TuyaDeviceConfig[] {
  const devices: TuyaDeviceConfig[] = [];
  for (let i = 1; ; i++) {
    const id = process.env[`TUYA_DEVICE_${i}_ID`];
    if (!id) break;
    devices.push({
      name: process.env[`TUYA_DEVICE_${i}_NAME`] ?? `gtb800-${i}`,
      id,
      key: required(`TUYA_DEVICE_${i}_KEY`),
      ip: required(`TUYA_DEVICE_${i}_IP`),
      powerDp: process.env[`TUYA_DEVICE_${i}_POWER_DP`] ?? "19",
      powerScale: Number(process.env[`TUYA_DEVICE_${i}_POWER_SCALE`] ?? "10"),
    });
  }
  if (devices.length === 0) {
    throw new Error(
      "No Tuya devices configured. Set TUYA_DEVICE_1_ID / _KEY / _IP (and _2_* for the second GTB-800).",
    );
  }
  return devices;
}

export type TuyaPlugConfig = {
  id: string;
  key: string;
  ip: string;
  // Boolean on/off dp code - "1" is the standard default for most Tuya
  // smart plugs, confirm with `npm run tuya:discover` if a plug doesn't
  // respond.
  switchDp: string;
  // Serial number of the battery this plug's AC output feeds - ties the
  // plug to a BatteryDriver.setChargeLimit() call in GatedBatteryDriver.
  gatesSn: string;
};

/**
 * Unlike loadTuyaDevices(), an empty result is valid here - not every
 * battery needs a physical AC cutoff, so no TUYA_PLUG_* vars being set just
 * means no device is gated.
 */
export function loadTuyaPlugs(): TuyaPlugConfig[] {
  const plugs: TuyaPlugConfig[] = [];
  for (let i = 1; ; i++) {
    const id = process.env[`TUYA_PLUG_${i}_ID`];
    if (!id) break;
    plugs.push({
      id,
      key: required(`TUYA_PLUG_${i}_KEY`),
      ip: required(`TUYA_PLUG_${i}_IP`),
      switchDp: process.env[`TUYA_PLUG_${i}_SWITCH_DP`] ?? "1",
      gatesSn: required(`TUYA_PLUG_${i}_GATES_SN`),
    });
  }
  return plugs;
}
