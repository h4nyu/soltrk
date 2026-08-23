/**
 * Anker Solix MQTT wire format, reverse engineered (see anker-driver/app.py
 * git history for the read side, and soltrk session notes for the write
 * side - there is no upstream reference for either on this device model).
 *
 * Message layout: `ff 09 <len LE16> <pattern x3> <msgtype x2> [<increment>]`
 * followed by `tag(1) length(1) value(length)` fields, then a trailing XOR
 * checksum byte over everything before it. The increment byte is present
 * only when byte 9 doesn't look like a tag (0xa0-0xa9) - ambiguous by
 * design (this is how the upstream library also parses it), but every
 * message we construct ourselves starts with tag 0xa1 right after the
 * header, so we never emit an increment byte.
 */

const OUTGOING_PATTERN = [0x03, 0x00, 0x0f];

export function parseTlvFields(data: Buffer): Map<number, Buffer> {
  const n = data.length;
  const hasIncrement = !(data[9] >= 0xa0 && data[9] <= 0xa9);
  let i = hasIncrement ? 10 : 9;
  const fields = new Map<number, Buffer>();
  while (i < n - 1) {
    const tag = data[i];
    const length = data[i + 1];
    const j = i + 2;
    if (j + length > n) break;
    fields.set(tag, data.subarray(j, j + length));
    i = j + length;
  }
  return fields;
}

export type A1765Status = {
  temperatureC?: number;
  batterySoc?: number;
  acOutputWatts?: number;
  acInputWatts?: number;
};

/**
 * Decode of SOLIX C1000X Gen 2 (A1765) `param_info` messages. Cross-checked
 * against the Anker app's own display across three units with different
 * live readings (exact match on SOC/temperature, watts within ~1-2W of
 * natural fluctuation) - see anker-driver/test_app.py for the original
 * captured fixtures this was validated against.
 */
export function parseA1765ParamInfo(data: Buffer): A1765Status {
  const fields = parseTlvFields(data);
  const result: A1765Status = {};
  const a5 = fields.get(0xa5);
  if (a5 && a5.length >= 4) {
    result.temperatureC = a5[1];
    result.batterySoc = a5[3];
  }
  const a6 = fields.get(0xa6);
  if (a6 && a6.length >= 5) {
    result.acOutputWatts = a6.readUInt16LE(1);
    result.acInputWatts = a6.readUInt16LE(3);
  }
  return result;
}

function xorChecksum(bytes: Buffer): number {
  let x = 0;
  for (const b of bytes) x ^= b;
  return x;
}

function buildMessage(msgtype: [number, number], fields: Buffer[]): Buffer {
  const fieldBytes = Buffer.concat(fields);
  const totalLen = 9 + fieldBytes.length + 1; // header + fields + checksum
  const header = Buffer.from([
    0xff,
    0x09,
    totalLen & 0xff,
    (totalLen >> 8) & 0xff,
    ...OUTGOING_PATTERN,
    msgtype[0],
    msgtype[1],
  ]);
  const withoutChecksum = Buffer.concat([header, fieldBytes]);
  return Buffer.concat([withoutChecksum, Buffer.from([xorChecksum(withoutChecksum)])]);
}

const FIXED_MARKER = Buffer.from([0xa1, 0x01, 0x22]);

/** msgtype 0x0057 - keeps the device pushing param_info/state_info updates. */
export function encodeRealtimeTrigger(timeoutSec = 60, now = Date.now()): Buffer {
  const a2 = Buffer.from([0xa2, 0x02, 0x01, 0x01]);
  const timeoutValue = Buffer.alloc(4);
  timeoutValue.writeUInt32LE(timeoutSec, 0);
  const a3 = Buffer.concat([Buffer.from([0xa3, 0x05, 0x03]), timeoutValue]);
  const tsValue = Buffer.alloc(4);
  tsValue.writeUInt32LE(Math.floor(now / 1000), 0);
  const fe = Buffer.concat([Buffer.from([0xfe, 0x05, 0x03]), tsValue]);
  return buildMessage([0x00, 0x57], [FIXED_MARKER, a2, a3, fe]);
}

/**
 * msgtype 0x0101 - sets AC charge limit in watts. Reverse engineered from a
 * live capture of the Anker app changing this exact setting (before/after
 * confirmed against the app's own displayed value - 100W and 200W samples,
 * both checksum- and value-verified).
 */
export function encodeSetChargeLimit(watts: number, now = Date.now()): Buffer {
  const wattsValue = Buffer.alloc(2);
  wattsValue.writeInt16LE(watts, 0);
  const a4 = Buffer.concat([Buffer.from([0xa4, 0x03, 0x02]), wattsValue]);
  const tsAscii = Buffer.from(String(Math.floor(now)), "ascii");
  const fdValue = Buffer.concat([Buffer.from([0x00]), tsAscii]);
  const fd = Buffer.concat([Buffer.from([0xfd, fdValue.length]), fdValue]);
  return buildMessage([0x01, 0x01], [FIXED_MARKER, a4, fd]);
}

/**
 * TOU period type, as seen in the `a7` field of a captured
 * msgtype 0x0090 message - confirmed for PEAK (1) and OFF_PEAK (3) by
 * diffing two live captures that differed only in this byte; MID_PEAK (2)
 * is inferred from ordering (untested).
 */
export const TouPeriodType = { PEAK: 1, MID_PEAK: 2, OFF_PEAK: 3 } as const;

/**
 * msgtype 0x0090 - sets the TOU (Time of Use) schedule to a single period
 * spanning `startHour`-`endHour` (0-24) of the given type. Reverse
 * engineered from a live capture of the Anker app's own "保存" action on
 * the TOU schedule screen - note the app itself doesn't publish this
 * directly, it calls a cloud HTTP endpoint that relays this exact MQTT
 * message with `head.client_id: "cloud"`; client_id is just envelope
 * metadata though; publishing this ourselves works the same way
 * `set_charge_limit` does. Only single whole-day-range schedules have been
 * captured/tested - the multi-period case (`a6`'s period count, and
 * presumably one `a7` per period) is unconfirmed.
 */
export function encodeSetTouSchedule(
  periodType: number,
  startHour = 0,
  endHour = 24,
  now = Date.now(),
): Buffer {
  const a2 = Buffer.from([0xa2, 0x02, 0x01, 0x01]);
  const a3 = Buffer.from([0xa3, 0x02, 0x01, 0x00]);
  const a4 = Buffer.from([0xa4, 0x02, 0x01, 0x00]);
  const a5 = Buffer.from([0xa5, 0x02, 0x01, 0x06]);
  const a6 = Buffer.from([0xa6, 0x02, 0x01, 0x01]);
  const a7 = Buffer.from([0xa7, 0x04, 0x04, periodType, startHour, endHour]);
  const tsValue = Buffer.alloc(4);
  tsValue.writeUInt32LE(Math.floor(now / 1000), 0);
  const fe = Buffer.concat([Buffer.from([0xfe, 0x05, 0x03]), tsValue]);
  return buildMessage([0x00, 0x90], [FIXED_MARKER, a2, a3, a4, a5, a6, a7, fe]);
}
