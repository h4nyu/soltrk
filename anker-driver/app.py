"""Local HTTP wrapper around anker-solix-api's MQTT session for PPS devices.

Exposes just enough surface for the soltrk control loop: list bound PPS
devices, read their live MQTT status (battery SOC etc.), and set their AC
charge limit. This library's reverse-engineered protocol is unofficial and
under active development upstream, so this driver stays a thin pass-through
and does not try to interpret or cache more than the library already gives us.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

from aiohttp import ClientSession
from anker_solix_api.api import AnkerSolixApi
from anker_solix_api.mqtt_factory import SolixMqttDeviceFactory
from anker_solix_api.mqtt_pps import MODELS as PPS_MODELS, SolixMqttDevicePps
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
_LOGGER = logging.getLogger("anker-driver")

CHARGE_LIMIT_MIN = 200
CHARGE_LIMIT_MAX = 1000
CHARGE_LIMIT_STEP = 100
REALTIME_TRIGGER_TIMEOUT_SEC = 300
REALTIME_TRIGGER_RENEW_SEC = 240


def _require_env(name: str) -> str:
    # docker-compose still sets an unset ${VAR} to an empty string rather
    # than omitting it, so os.environ[name] alone would not catch this.
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"Missing required env var: {name}")
    return value


class ChargeLimitRequest(BaseModel):
    watts: int


def _parse_tlv_fields(data: bytes) -> dict[int, bytes]:
    """Split an Anker Solix hex payload into {tag_byte: raw_value_bytes}.

    Header is `ff 09 <len_le16> <pattern x3> <msgtype x2> [<increment>]`
    (see anker_solix_api.mqtttypes.DeviceHexDataHeader); each field after
    that is `tag(1) length(1) value(length)`, and the final byte of the
    message is a checksum (not a field).
    """
    n = len(data)
    i = 10 if data[9] not in range(0xA0, 0xAA) else 9
    fields: dict[int, bytes] = {}
    while i < n - 1:
        tag = data[i]
        length = data[i + 1]
        j = i + 2
        if j + length > n:
            break
        fields[tag] = data[j : j + length]
        i = j + length
    return fields


def parse_a1765_param_info(data: bytes) -> dict:
    """Best-effort decode of SOLIX C1000X Gen 2 (A1765) `param_info` messages.

    anker-solix-api does not have a field mapping for this model yet (its
    generic extraction returns nothing for A1765), so this was reverse
    engineered directly from captured payloads and cross-checked against the
    Anker app's own display on two units with different readings:
      - fridge:  SOC 100%, 41C, AC in/out 47W/47W (app) vs decoded 100/41/48/48
      - office:  SOC  61%, 38C, AC in 140W, no output (app) vs decoded 61/38/141/0
    Tag `a5` value bytes: [type, temperature_c, _, battery_soc, max_soc, _]
    Tag `a6` value bytes: [type, out_watts_lo, out_watts_hi, in_watts_lo, in_watts_hi, ...]
    (battery_soc also appears as a6's last byte, which matched in both samples
    above and is used as a cross-check, not the primary source.)
    """
    fields = _parse_tlv_fields(data)
    result: dict = {}
    a5 = fields.get(0xA5)
    if a5 and len(a5) >= 4:
        result["temperature_c"] = a5[1]
        result["battery_soc"] = a5[3]
    a6 = fields.get(0xA6)
    if a6 and len(a6) >= 5:
        result["ac_output_watts"] = int.from_bytes(a6[1:3], "little")
        result["ac_input_watts"] = int.from_bytes(a6[3:5], "little")
        if "battery_soc" in result and a6[-1] != result["battery_soc"]:
            _LOGGER.warning(
                "a5/a6 battery_soc mismatch (%s vs %s) - byte offsets may not "
                "hold for this payload/firmware",
                result["battery_soc"],
                a6[-1],
            )
    return result


class DriverState:
    def __init__(self) -> None:
        self.websession: ClientSession | None = None
        self.api: AnkerSolixApi | None = None
        self.devices: dict[str, object] = {}  # sn -> SolixMqttDevicePps
        self.renew_tasks: list[asyncio.Task] = []
        self.manual_status: dict[str, dict] = {}  # sn -> parse_a1765_param_info() result


state = DriverState()


async def _renew_realtime_trigger(sn: str, device) -> None:
    # Caller already sent the initial trigger before spawning this task -
    # sleep first so we don't fire a redundant duplicate at t=0.
    while True:
        await asyncio.sleep(REALTIME_TRIGGER_RENEW_SEC)
        try:
            await device.realtime_trigger(timeout=REALTIME_TRIGGER_TIMEOUT_SEC)
        except Exception:
            _LOGGER.exception("realtime_trigger failed for %s", sn)


@asynccontextmanager
async def lifespan(_: FastAPI):
    email = _require_env("ANKER_EMAIL")
    password = _require_env("ANKER_PASSWORD")
    country = os.environ.get("ANKER_COUNTRY", "JP")
    allowlist = {
        sn.strip()
        for sn in os.environ.get("ANKER_DEVICE_SNS", "").split(",")
        if sn.strip()
    }

    state.websession = ClientSession()
    state.api = AnkerSolixApi(email, password, country, state.websession, _LOGGER)

    await state.api.update_sites()
    await state.api.get_bind_devices()

    for sn, device in state.api.devices.items():
        if allowlist and sn not in allowlist:
            continue
        if device.get("device_pn") not in PPS_MODELS:
            continue
        mqtt_device = SolixMqttDeviceFactory(
            api_instance=state.api, device_sn=sn
        ).create_device()
        if not isinstance(mqtt_device, SolixMqttDevicePps):
            # The factory gates on anker_solix_api.mqttmap.SOLIXMQTTMAP, which
            # A1765 (SOLIX C1000X Gen 2) is missing from even though
            # mqtt_pps.py's own MODELS set lists it as supported - it falls
            # back to a bare SolixMqttDevice with no set_charge_limit(). Build
            # the PPS class directly instead. Remove once upstream adds
            # A1765 to SOLIXMQTTMAP and the factory returns it natively.
            _LOGGER.warning(
                "Factory returned %s for %s (%s) instead of SolixMqttDevicePps "
                "- constructing it directly (SOLIXMQTTMAP workaround)",
                type(mqtt_device).__name__,
                sn,
                device.get("device_pn"),
            )
            mqtt_device = SolixMqttDevicePps(state.api, sn)
        state.devices[sn] = mqtt_device
        _LOGGER.info("Registered PPS device %s (%s)", sn, device.get("device_pn"))

    if not state.devices:
        _LOGGER.warning("No PPS devices registered - check ANKER_DEVICE_SNS")

    if not await state.api.startMqttSession():
        raise RuntimeError("Failed to start Anker MQTT session")

    # Creating a SolixMqttDevicePps and starting the session does NOT by
    # itself subscribe to that device's report topic (publishing commands
    # works regardless, which is why this is easy to miss) - without this,
    # realtime_trigger/status_request go out but nothing ever comes back.
    for sn, device in state.devices.items():
        dev_dict = state.api.devices.get(sn, {})
        topic = f"{state.api.mqttsession.get_topic_prefix(deviceDict=dev_dict)}#"
        resp = state.api.mqttsession.subscribe(topic)
        if resp and resp.is_failure:
            _LOGGER.warning("Failed to subscribe to MQTT topic for %s: %s", sn, topic)
        else:
            _LOGGER.info("Subscribed to MQTT topic for %s: %s", sn, topic)

    # Log receipt at INFO (topic/sn only, never payload - the library logs
    # full decoded payloads at DEBUG, which is unsafe: see README caveat on
    # LOG_LEVEL) so "is any data arriving at all" is visible without DEBUG.
    original_callback = state.api.mqttsession.message_callback()

    def _log_and_forward(mqttsession, topic, message, data, model, device_sn, extracted_values):
        _LOGGER.info("MQTT message received for %s (%s) on topic: %s", device_sn, model, topic)
        if model == "A1765" and topic.endswith("/param_info") and isinstance(data, bytes):
            try:
                decoded = parse_a1765_param_info(data)
            except Exception:
                _LOGGER.exception("A1765 param_info decode failed for %s", device_sn)
            else:
                if decoded:
                    state.manual_status[device_sn] = decoded
        if callable(original_callback):
            return original_callback(mqttsession, topic, message, data, model, device_sn, extracted_values)

    state.api.mqttsession.message_callback(func=_log_and_forward)

    for sn, device in state.devices.items():
        await device.realtime_trigger(timeout=REALTIME_TRIGGER_TIMEOUT_SEC)
        await device.status_request()
        state.renew_tasks.append(
            asyncio.create_task(_renew_realtime_trigger(sn, device))
        )

    yield

    for task in state.renew_tasks:
        task.cancel()
    await state.websession.close()


app = FastAPI(lifespan=lifespan)


def _get_device(sn: str):
    device = state.devices.get(sn)
    if device is None:
        raise HTTPException(status_code=404, detail=f"Unknown device sn: {sn}")
    return device


@app.get("/devices")
def list_devices():
    return [
        {"sn": sn, "pn": state.api.devices.get(sn, {}).get("device_pn")}
        for sn in state.devices
    ]


@app.get("/devices/{sn}/status")
def get_status(sn: str):
    device = _get_device(sn)
    # SolixMqttDevicePps.mqttdata is a snapshot taken at construction time,
    # not a live view - it only reflects new MQTT messages once update_device
    # re-syncs it from api.devices[sn]["mqtt_data"] (which mqtt_received()
    # does keep current). Pull-refresh it here rather than relying on the
    # library's push callback plumbing for a simple polled HTTP endpoint.
    device.update_device(state.api.devices.get(sn, {}))
    # Manually-decoded fields take precedence: anker-solix-api's own
    # extraction is currently empty for A1765 (see parse_a1765_param_info).
    return device.get_status() | state.manual_status.get(sn, {})


@app.post("/devices/{sn}/charge-limit")
async def set_charge_limit(sn: str, body: ChargeLimitRequest):
    device = _get_device(sn)
    watts = body.watts
    # watts=0 is passed through as a best-effort "stop charging" signal for
    # deprioritized devices. The library does not document what 0 does on
    # real hardware (min observed in the Anker app UI is 200W) - verify this
    # once against your own device before trusting it in the control loop.
    if watts != 0 and not (CHARGE_LIMIT_MIN <= watts <= CHARGE_LIMIT_MAX):
        raise HTTPException(
            status_code=400,
            detail=f"watts must be 0 or between {CHARGE_LIMIT_MIN} and {CHARGE_LIMIT_MAX}",
        )
    if watts % CHARGE_LIMIT_STEP != 0:
        raise HTTPException(
            status_code=400, detail=f"watts must be a multiple of {CHARGE_LIMIT_STEP}"
        )
    result = await device.set_charge_limit(max_watts=watts)
    if result is None:
        raise HTTPException(status_code=502, detail="set_charge_limit failed")
    return result
