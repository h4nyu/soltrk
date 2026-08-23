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
from anker_solix_api.mqtt_pps import MODELS as PPS_MODELS
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


class DriverState:
    def __init__(self) -> None:
        self.websession: ClientSession | None = None
        self.api: AnkerSolixApi | None = None
        self.devices: dict[str, object] = {}  # sn -> SolixMqttDevicePps
        self.renew_tasks: list[asyncio.Task] = []


state = DriverState()


async def _renew_realtime_trigger(sn: str, device) -> None:
    while True:
        try:
            await device.realtime_trigger(timeout=REALTIME_TRIGGER_TIMEOUT_SEC)
        except Exception:
            _LOGGER.exception("realtime_trigger failed for %s", sn)
        await asyncio.sleep(REALTIME_TRIGGER_RENEW_SEC)


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
        state.devices[sn] = mqtt_device
        _LOGGER.info("Registered PPS device %s (%s)", sn, device.get("device_pn"))

    if not state.devices:
        _LOGGER.warning("No PPS devices registered - check ANKER_DEVICE_SNS")

    if not await state.api.startMqttSession():
        raise RuntimeError("Failed to start Anker MQTT session")

    for sn, device in state.devices.items():
        await device.realtime_trigger(timeout=REALTIME_TRIGGER_TIMEOUT_SEC)
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
    return device.get_status()


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
