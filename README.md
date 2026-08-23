# soltrk

Keeps 2x GTB-800 plug-in solar microinverters (880W total) from backfeeding
the grid by routing their output into up to N Anker SOLIX portable power
stations, charged one at a time in a configured priority order (unit fills to
100% SOC, then the next unit takes over).

## How it works

- **Solar reading**: `soltrk` talks to the two GTB-800 units directly over
  the Tuya *local* protocol (no cloud) and sums their instantaneous power.
- **Anker control**: the C1000(X) has no local API. `anker-driver` (Python)
  wraps the community-reverse-engineered
  [`anker-solix-api`](https://github.com/thomluther/anker-solix-api) MQTT
  session to read battery SOC and set the AC charge limit (200-1000W, 100W
  steps - this is an Anker-imposed range, not something we invented).
- **Loop**: every `POLL_INTERVAL_MS`, `soltrk` reads total solar watts, picks
  the highest-priority Anker unit that isn't full yet, and sets its charge
  limit to the (floor-rounded) solar wattage. Every other unit is told to
  stop (`0W`) so it doesn't also trickle-charge from the grid in parallel.

This is a best-effort control loop built on an unofficial protocol, not a
certified zero-export device. Physically, commanding the active unit to draw
power *never exceeding* current solar output cannot itself cause backfeed -
worst case it draws a bit of grid power on top of solar, it can't push solar
power out to the grid - but skip the disclaimers if you already know this.

## Known caveats

- **200W floor**: below ~200W of solar (e.g. dawn/dusk), the charger can't be
  throttled proportionally. `MIN_SOLAR_TO_CHARGE_WATTS` (default 150W) is the
  cutoff below which we stop trying and just let panel output do whatever it
  does; above that we floor to 200W, which can mean a little grid draw on
  overcast mornings - it does not risk backfeed either way.
- **`0W` = "stop charging" is unverified.** The library documents 200-1000W
  from the app UI, but not what setting `0` does on real hardware. Test once
  manually (watch `docker compose logs -f soltrk` and the unit's own display)
  before trusting the "deprioritized units stay idle" behavior.
- **Unofficial protocol.** `anker-solix-api`'s MQTT support can change or
  break with Anker app/firmware updates; keep an eye on that project's
  releases.

## One-time setup

### 1. Tuya local keys for both GTB-800 units

You need each device's `id`, `local_key`, and LAN `ip` (tinytuya's
`wizard`/Tuya IoT Platform linking flow is the standard way to extract
these - not automated here, since it needs your own Tuya developer account).
Give each device a static IP/DHCP reservation so it doesn't change under you.

### 2. Confirm the power dp code and scale

The GTB-800's exact Tuya dp schema isn't published, so don't trust the
`TUYA_DEVICE_*_POWER_DP`/`_POWER_SCALE` defaults in `.env.example` blindly.
After building once (`docker compose build soltrk`), run:

```
docker compose run --rm soltrk npx tsx src/tuya/discover.ts <id> <key> <ip>
```

Watch which `dp` code moves in sync with the panel's actual instantaneous
output (compare against the Tuya/Smart Life app), and note if the value is
raw watts or needs dividing (commonly by 10) to get watts.

### 3. Anker account + device serials

Fill `ANKER_EMAIL` / `ANKER_PASSWORD` / `ANKER_COUNTRY` in `.env`. Start just
the driver and list devices to get serials:

```
cp .env.example .env   # fill it in first
docker compose up -d anker-driver
curl http://localhost:8000/devices
```

Put the serials you want managed, in charge priority order, into
`ANKER_PRIORITY_SNS`.

### 4. Run

```
docker compose up -d
```

Query current state any time with either:

```
cat data/state.json
docker compose exec soltrk npx tsx src/index.ts status
```

## Development

`./src` (soltrk) and `./anker-driver/app.py` are bind-mounted into their
containers, and both run with auto-reload (`tsx watch`, `uvicorn --reload`).
Edit and save - no `docker compose build` needed. A rebuild is only required
after changing `package.json`/`requirements.txt` (i.e. dependencies) or a
`Dockerfile`.
