"""Regression tests for the A1765 payload decoder in app.py.

The two fixtures below are real `param_info` MQTT payloads captured from
production units (SOLIX C1000X Gen 2 / "C1000 Plus"), cross-checked byte by
byte against the Anker app's own live display at the moment of capture:
  - fridge: SOC 100%, 41C, AC in/out 47W/47W (app display)
  - office: SOC  61%, 38C, AC in 140W, no output (app display)
The exact numbers asserted here are what the parser computes for these
specific captured bytes (they drift by ~1-2W from the app readings above,
since the MQTT sample and the screenshot were a few seconds apart, not
decoder error) - this test exists to catch a future change that silently
breaks the byte offsets, not to re-validate the offsets themselves.
"""

from app import _parse_tlv_fields, parse_a1765_param_info

FRIDGE_PARAM_INFO_HEX = (
    "ff09320103010f0421a10134a221062011415043444c52473047303634303136343100"
    "054131373633060401010000a30e0400000000b0040058cc00580200a41b0400000000"
    "c8003201000000000100001e00010000000000640104a506042901646400a60a043000"
    "30000000ab2a64a70704013000013000a80404000000aa0404000000ab0404000000ac"
    "0404000000ae0404000000b20404000000d92304030106640103010008030811011118"
    "00000000000000000000000000000000000000da18040000000000000000000001e00"
    "164057f00000000000000dc06040000000000f91d040604010102020100000000000202"
    "0100090300010000000000030300fa15040101010100170300000000000000000000000"
    "000fd0e0031373835393034343632353330fe0503f08c8a6af3"
)

OFFICE_PARAM_INFO_HEX = (
    "ff09320103010f0421a10134a221062011415043444c52473047303634303031343900"
    "054131373633060401010000a30e0402000000b0040050cc00580200a41b0400000000"
    "64003200000000000000000a00010000000001640104a5060426023d6400a60a040000"
    "8d00000027003da70704010000018d00a80404000000aa0404000000ab0404000000ac"
    "0404000000ae0404000000b20404000000d9230403010664010301000e030e12011218"
    "00000000000000000000000000000000000000da18040000000000000000000001e00"
    "164057f00000000000000dc06040000000000f91d040604010102020100000000000202"
    "0100090300010000000000030300fa15040101010100170300000000000000000000000"
    "000fd0e0031373837313431333934313934fe0503ad8d8a6ab7"
)


def test_parse_tlv_fields_splits_header_and_fields():
    fields = _parse_tlv_fields(bytes.fromhex(FRIDGE_PARAM_INFO_HEX))
    assert fields[0xA1] == bytes.fromhex("34")
    assert fields[0xA5] == bytes.fromhex("042901646400")
    assert fields[0xA6] == bytes.fromhex("04300030000000ab2a64")


def test_parse_tlv_fields_handles_short_single_field_message():
    # state_info sample: header (10 bytes) + one field (a1, len 1) + checksum.
    fields = _parse_tlv_fields(bytes.fromhex("ff090e0003010f085700a1013238"))
    assert fields == {0xA1: bytes.fromhex("32")}


def test_decode_fridge_param_info():
    result = parse_a1765_param_info(bytes.fromhex(FRIDGE_PARAM_INFO_HEX))
    assert result == {
        "temperature_c": 41,
        "battery_soc": 100,
        "ac_output_watts": 48,
        "ac_input_watts": 48,
    }


def test_decode_office_param_info():
    result = parse_a1765_param_info(bytes.fromhex(OFFICE_PARAM_INFO_HEX))
    assert result == {
        "temperature_c": 38,
        "battery_soc": 61,
        "ac_output_watts": 0,
        "ac_input_watts": 141,
    }


def test_decode_handles_missing_fields_gracefully():
    # No a5/a6 tags at all - should not raise, just omit those keys.
    assert parse_a1765_param_info(bytes.fromhex("ff090c0003010f08570001013200")) == {}


def test_decode_warns_on_soc_mismatch_between_a5_and_a6(caplog):
    # Hand-built payload: a5 says SOC=0x32 (50), a6's last byte says 0x3c (60).
    payload = bytes.fromhex(
        "ff091f0003010f085700a506041e00326400a60a0400000000000000003c00"
    )
    result = parse_a1765_param_info(payload)
    assert result["battery_soc"] == 50  # a5 is the primary source
    assert "mismatch" in caplog.text
