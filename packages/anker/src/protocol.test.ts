import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { encodeRealtimeTrigger, encodeSetChargeLimit, parseA1765ParamInfo, parseTlvFields } from "./protocol";

// Real payloads captured from production units (SOLIX C1000X Gen 2 / "C1000
// Plus"), cross-checked byte for byte against the Anker app's own live
// display at the moment of capture:
//   fridge: SOC 100%, 41C, AC in/out 47W/47W (app display)
//   office: SOC  61%, 38C, AC in 140W, no output (app display)
// The exact numbers asserted below are what the parser computes for these
// specific captured bytes (they drift by ~1-2W from the app readings above,
// since the MQTT sample and the screenshot were a few seconds apart, not
// decoder error) - this exists to catch a future change that silently
// breaks the byte offsets, not to re-validate the offsets themselves.
const FRIDGE_PARAM_INFO_HEX =
  "ff09320103010f0421a10134a221062011415043444c52473047303634303136343100" +
  "054131373633060401010000a30e0400000000b0040058cc00580200a41b0400000000" +
  "c8003201000000000100001e00010000000000640104a506042901646400a60a043000" +
  "30000000ab2a64a70704013000013000a80404000000aa0404000000ab0404000000ac" +
  "0404000000ae0404000000b20404000000d92304030106640103010008030811011118" +
  "00000000000000000000000000000000000000da18040000000000000000000001e00" +
  "164057f00000000000000dc06040000000000f91d040604010102020100000000000202" +
  "0100090300010000000000030300fa15040101010100170300000000000000000000000" +
  "000fd0e0031373835393034343632353330fe0503f08c8a6af3";

const OFFICE_PARAM_INFO_HEX =
  "ff09320103010f0421a10134a221062011415043444c52473047303634303031343900" +
  "054131373633060401010000a30e0402000000b0040050cc00580200a41b0400000000" +
  "64003200000000000000000a00010000000001640104a5060426023d6400a60a040000" +
  "8d00000027003da70704010000018d00a80404000000aa0404000000ab0404000000ac" +
  "0404000000ae0404000000b20404000000d9230403010664010301000e030e12011218" +
  "00000000000000000000000000000000000000da18040000000000000000000001e00" +
  "164057f00000000000000dc06040000000000f91d040604010102020100000000000202" +
  "0100090300010000000000030300fa15040101010100170300000000000000000000000" +
  "000fd0e0031373837313431333934313934fe0503ad8d8a6ab7";

describe("parseTlvFields", () => {
  test("splits header and fields", () => {
    const fields = parseTlvFields(Buffer.from(FRIDGE_PARAM_INFO_HEX, "hex"));
    assert.deepEqual(fields.get(0xa1), Buffer.from("34", "hex"));
    assert.deepEqual(fields.get(0xa5), Buffer.from("042901646400", "hex"));
    assert.deepEqual(fields.get(0xa6), Buffer.from("04300030000000ab2a64", "hex"));
  });

  test("handles a short single-field message", () => {
    // state_info sample: header (10 bytes) + one field (a1, len 1) + checksum.
    const fields = parseTlvFields(Buffer.from("ff090e0003010f085700a1013238", "hex"));
    assert.deepEqual([...fields.entries()], [[0xa1, Buffer.from("32", "hex")]]);
  });
});

describe("parseA1765ParamInfo", () => {
  test("decodes the fridge sample", () => {
    const result = parseA1765ParamInfo(Buffer.from(FRIDGE_PARAM_INFO_HEX, "hex"));
    assert.deepEqual(result, {
      temperatureC: 41,
      batterySoc: 100,
      acOutputWatts: 48,
      acInputWatts: 48,
    });
  });

  test("decodes the office sample", () => {
    const result = parseA1765ParamInfo(Buffer.from(OFFICE_PARAM_INFO_HEX, "hex"));
    assert.deepEqual(result, {
      temperatureC: 38,
      batterySoc: 61,
      acOutputWatts: 0,
      acInputWatts: 141,
    });
  });

  test("returns an empty object when a5/a6 are absent", () => {
    const result = parseA1765ParamInfo(Buffer.from("ff090c0003010f08570001013200", "hex"));
    assert.deepEqual(result, {});
  });
});

describe("command encoding", () => {
  test("encodeRealtimeTrigger matches a real captured command", () => {
    // Captured from our own driver publishing this exact command (timeout=60s).
    const capturedTimestampMs = 0x6a8a98ba * 1000;
    const encoded = encodeRealtimeTrigger(60, capturedTimestampMs);
    assert.equal(
      encoded.toString("hex"),
      "ff091f0003000f0057a10122a2020101a305033c000000fe0503ba988a6a33",
    );
  });

  test("encodeSetChargeLimit matches a real captured 200W command", () => {
    // Captured from the Anker app setting 交流電池充電 to 200W.
    const encoded = encodeSetChargeLimit(200, 1787468011852);
    assert.equal(
      encoded.toString("hex"),
      "ff09220003000f0101a10122a40302c800fd0e0031373837343638303131383532f8",
    );
  });

  test("encodeSetChargeLimit matches a real captured 100W command", () => {
    // Captured from the Anker app setting 交流電池充電 to 100W (confirmed
    // against the app's own displayed setting afterward).
    const encoded = encodeSetChargeLimit(100, 1787468026600);
    assert.equal(
      encoded.toString("hex"),
      "ff09220003000f0101a10122a403026400fd0e003137383734363830323636303059",
    );
  });
});
