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
