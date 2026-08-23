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
`TUYA_DEVICE_*_POWER_DP`/`_POWER_SCALE` defaults in `docker-compose.yml`
blindly. After building once (`docker compose build soltrk`), run:

```
docker compose run --rm soltrk npx tsx src/tuya/discover.ts <id> <key> <ip>
```

Watch which `dp` code moves in sync with the panel's actual instantaneous
output (compare against the Tuya/Smart Life app), and note if the value is
raw watts or needs dividing (commonly by 10) to get watts.

### 3. Anker account + device serials

All env vars are declared in the `x-env` block at the top of
`docker-compose.yml` (required ones as bare `${VAR}`, optional ones with a
`${VAR:-default}` fallback, and internal service-wiring values hardcoded) -
that file is the source of truth for what exists and its default, not a
separate `.env.example`. Create a git-ignored `.env` next to it with at least
the required keys (`ANKER_EMAIL`, `ANKER_PASSWORD`, `ANKER_PRIORITY_SNS`,
`TUYA_DEVICE_1_*`, `TUYA_DEVICE_2_*`), then start just the driver and list
devices to get serials:

```
docker compose up -d anker-driver
curl http://localhost:8000/devices
```

`ANKER_PRIORITY_SNS` only seeds the *initial* priority order (see below) -
list the serials there in the order you want them charged.

### 4. Priority order (`data/priority.json`)

Charge priority isn't fixed at startup: `soltrk` re-reads
`data/priority.json` every cycle, so it can be changed live without
restarting anything. It's seeded from `ANKER_PRIORITY_SNS` on first run,
one entry per battery:

```json
[
  { "sn": "APCDLRG0G06401641", "name": "冷蔵庫", "vendor": "anker", "priority": 1 },
  { "sn": "APCDLRG0G06400974", "name": "キッチン", "vendor": "anker", "priority": 2 }
]
```

Lower `priority` number charges first; a unit is skipped once its SOC hits
100%. Edit the file directly (e.g. reorder the numbers) to change it; `name`
is just for readable logs/`status` output, and `vendor` selects which
adapter in `src/battery/registry.ts` talks to that serial (defaults to
`"anker"` if omitted - see Architecture below).

### 5. Run

```
docker compose up -d
```

Query current state any time with either:

```
cat data/state.json
docker compose exec soltrk npx tsx src/index.ts status
```

## Architecture: adding another battery/charger vendor

The control loop and allocator never talk to `AnkerClient` directly - they
depend only on the `BatteryDriver` port (`src/battery/BatteryDriver.ts`):

```ts
interface BatteryDriver {
  getStatus(sn: string): Promise<{ batterySoc?: number } | undefined>;
  setChargeLimit(sn: string, watts: number): Promise<boolean>;
}
```

`AnkerClient` is the one adapter implementing it today (talking to the
separate Python `anker-driver` service, since that's where the only working
reverse-engineered protocol lib lives - a vendor adapter is free to be a
thin HTTP client, a driver process of its own, or call a library directly,
whatever that vendor needs). To add a second brand: write a new class
implementing `BatteryDriver`, register it in `src/battery/registry.ts`
under a vendor key, and tag that battery's `data/priority.json` entry with
`"vendor": "<your key>"`. No changes needed in `loop.ts` or `allocator.ts`.

## Development

`./src` (soltrk) and `./anker-driver/app.py` are bind-mounted into their
containers, and both run with auto-reload (`tsx watch`, `uvicorn --reload`).
Edit and save - no `docker compose build` needed. A rebuild is only required
after changing `package.json`/`requirements.txt` (i.e. dependencies) or a
`Dockerfile`.
