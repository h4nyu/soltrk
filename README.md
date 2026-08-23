# soltrk

Keeps 2x GTB-800 plug-in solar microinverters (880W total) from backfeeding
the grid by routing their output into up to N Anker SOLIX portable power
stations, charged one at a time in a configured priority order (unit fills to
100% SOC, then the next unit takes over).

## Layout

An npm workspaces monorepo, split by layer (ports/business logic vs.
adapters), the same shape as the sibling `picomanager` project:

- **`packages/core`** - the vendor-neutral domain: the `BatteryDriver` and
  `SolarSource` ports, the priority allocator, and the control loop
  (`runLoop`). Depends on nothing but its own ports - it never imports Anker
  or Tuya code directly.
- **`packages/anker`** - the one `BatteryDriver` adapter today
  (`NativeAnkerClient`): Anker cloud login, AWS IoT MQTT session, and the
  hand-reverse-engineered A1765 wire format. See "How it works" below.
- **`packages/tuya`** - the one `SolarSource` adapter today: reads the two
  GTB-800 microinverters over the Tuya *local* protocol (no cloud).
- **`packages/cli`** - the composition root / app: env var parsing
  (`config.ts`), the vendor registry that wires `NativeAnkerClient` into the
  `BatteryDriver` port (`battery/registry.ts`, analogous to picomanager's
  `Infrastructure()` factory), and the CLI entrypoint (`index.ts`, a
  [commander](https://github.com/tj/commander.js)-based `run`/`status` CLI
  registered as the `soltrk` bin - runnable directly inside the container,
  e.g. `docker compose exec soltrk soltrk --help`). Only `run` reads
  Anker/Tuya env vars; `--help`, `--version`, and `status` work without them.

## How it works

- **Solar reading**: `soltrk` talks to the two GTB-800 units directly over
  the Tuya *local* protocol (no cloud) and sums their instantaneous power.
- **Anker control**: the C1000X Gen 2 (A1765, sold as "SOLIX C1000 Plus" in
  the app) has no local API and no support in the community
  [`anker-solix-api`](https://github.com/thomluther/anker-solix-api) project
  either (its generic MQTT decoder and command-encoder both return nothing
  for this model). `packages/anker` is a from-scratch TypeScript client: it
  logs into Anker's cloud (reverse engineered ECDH+AES login, see
  `packages/anker/src/crypto.ts`), opens the same AWS IoT MQTT session the
  app uses, and reads/writes the A1765 wire format directly
  (`packages/anker/src/protocol.ts`) - reverse engineered by hand and
  cross-validated against the Anker app's own displayed values on real
  hardware (see the tests alongside it).
- **Loop**: every `POLL_INTERVAL_MS`, `soltrk` reads total solar watts, picks
  the highest-priority Anker unit that isn't full yet, and sets its charge
  limit to the solar wattage rounded *up* to the next 100W step. Every other
  unit is told to charge at the hardware's minimum (100W - there's no real
  "0W/off", see below), so it never gets left at a stale higher limit from
  when it was previously the active unit.

### Reverse engineering a new command

Every write command so far (`set_charge_limit`, `realtime_trigger`) was
found the same way, without any TLS interception (mitmproxy etc.) - AWS IoT
just lets our own MQTT session subscribe to the *app's own* publish topic,
not only the device's:

1. Run `docker compose run --rm soltrk npx tsx packages/anker/src/captureMqtt.ts <device_sn>`
   - this logs into the same Anker account and subscribes to both
   `dt/{app}/{pn}/{sn}/#` (device -> cloud) and `cmd/{app}/{pn}/{sn}/#`
   (app -> device, i.e. the topic the real Anker app itself publishes to).
2. Perform the action in the real Anker app (e.g. flip a setting).
3. The script logs every message's topic and decoded hex payload on both
   topics, including the exact command the app just sent - decode/replicate
   it in `packages/anker/src/protocol.ts` the same way as the existing
   commands (see `encodeSetChargeLimit`/`encodeRealtimeTrigger`).

This technique has a limit, hit while trying to reverse engineer the TOU
schedule "保存" action: `encodeSetTouSchedule` (msgtype `0x0090`) is decoded
and byte-exact against two real captures, but publishing it ourselves does
**not** actually change the device's behavior. That capture's
`head.client_id` was `"cloud"`, not the app's own client id like every
other captured command - the real write happens through a cloud HTTP
endpoint the app calls, and the cloud relays this MQTT message as a
downstream *notification* afterward, not as the authoritative write itself.
Replaying only the MQTT side isn't enough for commands like this; that
endpoint hasn't been found (checked the `anker-solix-api` project's
Solarbank-2-equivalent, `schedule.py`'s `set_sb2_use_time` - different
device class, and explicitly marked unimplemented there too).

This is a best-effort control loop built on an unofficial, hand-decoded
protocol, not a certified zero-export device. The charger is deliberately
commanded to draw *at least* current solar output (never less): total load
then always meets or exceeds solar generation, which guarantees no backfeed
regardless of what the rest of the house is doing - it can only ever mean
pulling a little extra from the grid on top of solar, never push solar power
out to the grid - but skip the disclaimers if you already know this.

## Known caveats

- **100W floor, rounds up**: below ~100W of solar (e.g. dawn/dusk), the
  charger can't be throttled proportionally. `MIN_SOLAR_TO_CHARGE_WATTS`
  (default 150W) is the cutoff below which we stop trying and just let panel
  output do whatever it does; above that, and up through every 100W step, the
  target is rounded up (not down) so the charger always draws at least as
  much as solar is currently producing - the small overshoot (up to 99W) is
  extra grid draw, which is the deliberate trade-off for the backfeed
  guarantee above. If you know a constant amount of house load is always
  present (fridge compressor, routers, etc), set `HOUSE_STANDBY_WATTS` to it
  - that much of solar is treated as already spoken for and doesn't need
  covering by the charger, shrinking the overshoot. Leave at `0` (default) if
  unsure; setting it too high is what could actually cause backfeed.
- **`setChargeLimit` cannot fully stop charging by itself.** 100-1200W in
  100W steps all work as expected, confirmed against the Anker app's own
  displayed "交流電池充電" setting on real hardware, but that setting has no
  "0" - values below 100W get silently clamped up to the 100W floor by the
  device firmware rather than rejected (`chargeLimitMin`/`Max` in
  `config.ts` are set to the app's real 100-1200W range for this reason).
  Worse, on real hardware even a valid low wattage request was fully
  ignored whenever the device's own **TOU (Time of Use) schedule** was in
  its "オフピーク" period, which always charges from AC regardless of any
  wattage soltrk requests - soltrk's charge-limit command and the device's
  own TOU schedule are two independent layers, and TOU wins. For a
  deprioritized unit's charging to actually stop, its TOU schedule must be
  in "ピーク" (battery-priority, falls back to grid only once empty - no
  charging) or "ミッドピーク" (grid pass-through, no charging) for that
  time period, set manually in the Anker app - soltrk has no known command
  to read or change a device's TOU schedule. This also means: if a unit's
  TOU schedule is "ピーク"/"ミッドピーク" all day, soltrk's own charge
  commands when solar *is* available may be blocked the same way - not yet
  confirmed either way in daylight.
- **Hand-decoded protocol, single device model.** Only A1765 (SOLIX C1000X
  Gen 2) has a decoder/encoder (`packages/anker/src/protocol.ts`); there is
  no upstream reference for this model's wire format at all, read or write,
  so it was reverse engineered directly from captured MQTT traffic. A
  different Anker PPS model would need its own field mapping - the
  byte-level TLV framing is likely the same (see `parseTlvFields`), but the
  per-message-type field meanings (tags like `a5`/`a6`/`a4`) are not
  guaranteed to match. Anker app/firmware updates could also change this at
  any time with no changelog to watch.

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
docker compose run --rm soltrk npx tsx packages/tuya/src/discover.ts <id> <key> <ip>
```

Watch which `dp` code moves in sync with the panel's actual instantaneous
output (compare against the Tuya/Smart Life app), and note if the value is
raw watts or needs dividing (commonly by 10) to get watts.

### 3. Anker account + device serials

All env vars are declared in the `x-env` block at the top of
`docker-compose.yml` (required ones as bare `${VAR}`, optional ones with a
`${VAR:-default}` fallback) - that file is the source of truth for what
exists and its default, not a separate `.env.example`. Create a git-ignored
`.env` next to it with at least the required keys (`ANKER_EMAIL`,
`ANKER_PASSWORD`, `ANKER_PRIORITY_SNS`, `TUYA_DEVICE_1_*`,
`TUYA_DEVICE_2_*`).

To find your device serials, log in once via a throwaway script, e.g.:

```
docker compose run --rm soltrk npx tsx -e "
  import('@soltrk/anker').then(async (m) => {
    const s = await m.login(process.env.ANKER_EMAIL!, process.env.ANKER_PASSWORD!, process.env.ANKER_COUNTRY ?? 'JP');
    console.log(await m.getBindDevices(s));
  });
"
```

`ANKER_PRIORITY_SNS` only seeds the *initial* priority order (see below) -
list the serials there in the order you want them charged.

**Note:** the Anker cloud allows only one active login per account at a
time - running this (or `soltrk` itself) will log the phone app out of that
account. It can just log back in; the two don't fight over it once both are
logged in independently.

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
adapter in `packages/cli/src/battery/registry.ts` talks to that serial
(defaults to `"anker"` if omitted - see Architecture below).

### 5. Run

```
docker compose up -d
```

Query current state any time with either:

```
cat data/state.json
docker compose exec soltrk soltrk status
```

## Architecture: adding another battery/charger vendor

`packages/core`'s control loop and allocator never talk to
`NativeAnkerClient` directly - they depend only on the `BatteryDriver` port
(`packages/core/src/battery/BatteryDriver.ts`):

```ts
type BatteryDriver = {
  getStatus(sn: string): Promise<BatteryStatus | undefined>;
  setChargeLimit(sn: string, watts: number): Promise<boolean>;
};
```

`NativeAnkerClient` (`packages/anker`) is the one adapter implementing it
today. To add a second brand: create a new `packages/<vendor>` implementing
`BatteryDriver` (depending on `@soltrk/core` for the port type, nothing
else), register an instance of it in `packages/cli/src/battery/registry.ts`
under a vendor key, and tag that battery's `data/priority.json` entry with
`"vendor": "<your key>"`. No changes needed in `packages/core`. The same
pattern applies to solar sources via the `SolarSource` port if you ever add
a second panel/inverter integration.

## Development

`./packages` is bind-mounted into the container and it runs with
auto-reload (`tsx watch`). Edit and save - no `docker compose build`
needed. A rebuild is only required after changing a `package.json`
(workspace or dependency changes) or the `Dockerfile`.

TypeScript compiles as a single program from the root `tsconfig.json`
(`include: ["packages/*/src"]`) rather than per-package builds -
npm workspaces here is purely for dependency/import-boundary clarity
(`@soltrk/core`, `@soltrk/anker`, `@soltrk/tuya`, `@soltrk/cli`), not
independent compilation.

Run the test suite (crypto cross-validated against the Python reference
implementation with a fixed key, protocol encode/decode against real
captured payloads - see `packages/anker/src/*.test.ts`) with:

```
docker compose run --rm --no-deps soltrk npm test
```
