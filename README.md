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
  e.g. `docker compose run --rm app soltrk --help`). Only `run` reads
  Anker/Tuya env vars; `--help`, `--version`, and `status` work without them.

`docker-compose.yml` defines two services off the same image and `x-app`
anchor (same pattern as picomanager): `app` has no `command` and is never
`up` - it's for one-off dev work only (`docker compose run --rm app
<anything>`, e.g. `npx tsc --noEmit`, `npm test`, `soltrk --help`), so a
throwaway container per invocation, nothing left running to accidentally
restart mid-edit. `soltrk` is the real system: its `command` runs the
control loop, and it's the one you `docker compose up -d soltrk`.

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
- **Loop**: every `POLL_INTERVAL_MS` (default 1 minute), `soltrk` reads total
  solar watts and steers one number toward zero: `balance = solar - total
  battery AC input` (logged each cycle and written to `data/state.json`).
  The highest-priority unit that isn't full yet is the *active* charging
  target: it's asked to charge at the current solar output *minus whatever
  the other units are already measured to be drawing* (their critical-SOC
  rescue charging, or a full unit's passthrough - see below), capped at the
  hardware max (1200W). No gradual ramp-up: an earlier version ramped the
  request, but once it's capped at actual solar the ramp just added lag,
  and real solar changes gradually enough on its own (observed: roughly an
  hour from 0 to peak in the morning). Every non-active unit idles at the
  hardware's minimum request (100W - there's no real "0W/off", see below);
  whether it's actually *connected* to AC is a separate per-unit decision:
  the active unit and any full (100% SOC) unit stay connected while solar
  is sufficient - a full unit doesn't charge, but with AC present it passes
  solar straight through to its own load instead of draining its battery,
  which avoids both the 99⇄100% plug-flapping a cut-off full unit would
  cycle through and the double conversion loss of going via the battery -
  everything else is disconnected (see the smart-plug section under
  One-time setup).

### Reverse engineering a new command

Every write command so far (`set_charge_limit`, `realtime_trigger`) was
found the same way, without any TLS interception (mitmproxy etc.) - AWS IoT
just lets our own MQTT session subscribe to the *app's own* publish topic,
not only the device's:

1. Run `docker compose run --rm app npx tsx packages/anker/src/capture-mqtt.ts <device_sn>`
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
protocol, minimizing backfeed rather than a certified zero-export
guarantee. An earlier version deliberately over-requested (rounding solar
up, or asking outright for the hardware max) so that requested draw always
met or exceeded generation - but real hardware doesn't reliably obey a
specific requested wattage anyway (observed drawing 137W against a 100W
request), so that "guarantee" was already only as good as the hardware's
own precision. The current design instead asks for exactly the current
solar output (see "How it works") and accepts that some backfeed is
possible, since the poll cycle (1 minute by default) means the system only
reacts to solar changes after the fact regardless of how the target
wattage is computed. At this deployment's scale (two GTB-800 panels, ~660W
combined peak) any such backfeed is expected to be small and brief - this
is a deliberate trade-off against needless grid draw, not an oversight, but
skip the disclaimers only if you understand it.

## Known caveats

- **100W floor**: below ~100W of solar (e.g. dawn/dusk), the charger can't
  be throttled proportionally. `MIN_SOLAR_TO_CHARGE_WATTS` (default 150W) is
  the cutoff below which we stop trying and just let panel output do
  whatever it does. If you know a constant amount of house load is always
  present (fridge compressor, routers, etc), set `HOUSE_STANDBY_WATTS` to it
  - that much of solar is treated as already spoken for and doesn't need
  covering by the charger. Leave at `0` (default) if unsure; setting it too
  high is what could actually cause backfeed.
- **The requested wattage is a rough dial, not a precise one.** Real
  hardware doesn't reliably obey a specific requested wattage - a 100W
  request was observed drawing 137W on real hardware. `soltrk` treats the
  requested number as an approximate ceiling and steers by the measured
  balance instead (see "How it works"); the ~30W conversion overhead while
  charging is also why a full unit's passthrough (no charging, no
  conversion) is deliberately preferred over cycling its battery.
- **`setChargeLimit` cannot fully stop charging by itself, regardless of
  mode.** 100-1200W all work as expected, confirmed against the Anker app's
  own displayed "交流電池充電" setting on real hardware, but that setting has
  no "0" - values below 100W get silently clamped up to the 100W floor by
  the device firmware rather than rejected (`chargeLimitMin`/`Max` in
  `config.ts` are set to the app's real 100-1200W range for this reason).
  Worse, on real hardware a 100W request was observed still drawing 137W -
  and this was seen with the unit already in **標準モード (Standard mode)**,
  not just under a TOU (Time of Use) "オフピーク" schedule as originally
  suspected - so this isn't a TOU-specific quirk, it's a general limit of
  the wattage command itself, in any mode. Dynamic TOU control from soltrk
  was also explored and abandoned: the schedule-change command was reverse
  engineered (`encodeSetTouSchedule` in `protocol.ts`) but replaying it
  directly over MQTT doesn't take effect, because the real write goes
  through an unidentified Anker cloud HTTP endpoint, not the MQTT message
  alone (see "Reverse engineering a new command" below). Since neither the
  wattage command nor TOU can be driven reliably from software in any mode,
  the practical fix is the physical smart-plug AC cutoff described in
  "One-time setup" step 6, which sidesteps this entirely - all 3 of this
  deployment's units are gated this way and run in 標準モード.
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

You need each device's `id` and `local_key` (tinytuya's `wizard`/Tuya IoT
Platform linking flow is the standard way to extract these - not automated
here, since it needs your own Tuya developer account). No IP is needed in
config: it's resolved dynamically at connect time via UDP broadcast
(tuyapi's `find()`), since this network's devices don't have DHCP
reservations and their IPs drift - see "How it works" for why, and note
this requires `network_mode: host` (already set in `docker-compose.yml`;
requires Docker Desktop's host networking support to be enabled under
Settings > Resources > Network).

Create a git-ignored `data/tuya.json` (same `./data` volume mount as
`state.json`/`priority.json` - it holds secrets, hence `data/` and not
`.env`/`docker-compose.yml`, where numbered env vars plus shell-escaping
for keys containing `$` got painful once there were several devices):

```json
{
  "devices": [
    { "name": "gtb800-1", "id": "...", "key": "..." },
    { "name": "gtb800-2", "id": "...", "key": "..." }
  ],
  "plugs": []
}
```

`name` is optional (defaults to `gtb800-N`); `plugs` is for step 6 below
and can start empty/omitted.

### 2. Confirm the power dp code and scale

The GTB-800's exact Tuya dp schema isn't published, so don't trust the
`powerDp`/`powerScale` defaults (`"19"`/`10`) blindly - add `"powerDp"` /
`"powerScale"` fields to a device's entry in `data/tuya.json` to override
them. After building once (`docker compose build`), run:

```
docker compose run --rm app npx tsx packages/tuya/src/discover.ts <id> <key>
```

Watch which `dp` code moves in sync with the panel's actual instantaneous
output (compare against the Tuya/Smart Life app), and note if the value is
raw watts or needs dividing (commonly by 10) to get watts.

### 3. Anker account + device serials

Anker credentials are plain env vars (they don't change often and aren't
secrets-heavy the way Tuya's numbered keys were) - declared in the `x-env`
block at the top of `docker-compose.yml` (required ones as bare `${VAR}`,
optional ones with a `${VAR:-default}` fallback), which is the source of
truth for what exists and its default, not a separate `.env.example`.
Create a git-ignored `.env` next to it with at least `ANKER_EMAIL` and
`ANKER_PASSWORD`.

To find your device serials, log in once via a throwaway script, e.g.:

```
docker compose run --rm app npx tsx -e "
  import('@soltrk/anker').then(async (m) => {
    const s = await m.login(process.env.ANKER_EMAIL!, process.env.ANKER_PASSWORD!, process.env.ANKER_COUNTRY ?? 'JP');
    if (s instanceof Error) throw s;
    console.log(await m.getBindDevices(s));
  });
"
```

**Note:** the Anker cloud allows only one active login per account at a
time - running this (or `soltrk` itself) will log the phone app out of that
account. It can just log back in; the two don't fight over it once both are
logged in independently.

### 4. Priority order (`data/priority.json`)

Charge priority isn't fixed at startup: `soltrk` re-reads
`data/priority.json` every cycle, so it can be changed live without
restarting anything. There's no env-var seed for it (same reasoning as
Tuya's config file - it would just be a one-time default for a file that's
the live source of truth forever after) - create it directly, one entry
per battery:

```json
[
  { "sn": "APCDLRG0G06401641", "name": "冷蔵庫", "vendor": "anker-gated", "priority": 1 },
  { "sn": "APCDLRG0G06400974", "name": "キッチン", "vendor": "anker", "priority": 2 }
]
```

Lower `priority` number charges first; a unit is skipped once its SOC hits
100%. Edit the file directly (e.g. reorder the numbers) to change it; `name`
is just for readable logs/`status` output, and `vendor` selects which
adapter in `packages/cli/src/battery/registry.ts` talks to that serial
(defaults to `"anker"` if omitted - see Architecture below). Use
`"anker-gated"` for any sn with a physical AC-cutoff smart plug configured
(step 6).

### 5. Run

```
docker compose up -d soltrk
```

Query current state any time with either:

```
cat data/state.json
docker compose exec soltrk soltrk status
```

Code changes need an explicit `docker compose restart soltrk` to take
effect - nothing reloads automatically (see the service split note under
"Layout" above).

### 6. Physical AC cutoff via Tuya smart plug (optional, per-battery)

Since neither `setChargeLimit` nor the TOU schedule can be driven reliably
from software (see "Known caveats" above), a plain Tuya smart plug wired in
series with a battery's AC input cable gives a hard on/off gate that
doesn't depend on the Anker device's firmware at all - if there's no AC
power at the wall, the device can't charge, full stop.

Onboard the plug the same way as the GTB-800 units (Tuya IoT Platform
"Link App Account", API Explorer for the `local_key` - see step 1; no LAN
IP needed), then confirm its switch dp with the same `discover.ts` script
used for the panels:

```
docker compose run --rm app npx tsx packages/tuya/src/discover.ts <id> <key>
```

`"1"` is the standard boolean on/off dp for most Tuya plugs and is the
default if a plug entry omits `"switchDp"`. Then add to `data/tuya.json`'s
`"plugs"` array:

```json
{ "id": "...", "key": "...", "gatesSn": "APCDLRG0G06401641" }
```

(`gatesSn` is the battery this plug's output feeds), and set that
battery's `vendor` to `"anker-gated"` in `data/priority.json` (step 4).
`GatedBatteryDriver` (`packages/cli/src/battery/gated-battery-driver.ts`)
then cuts the plug whenever the allocator deprioritizes that battery, and
restores it (plus still sending the normal wattage command for fine
control) whenever it's the active charging target - any sn with no
matching plug entry is unaffected and behaves exactly like plain `"anker"`.

**Safety floor:** a gated device can be cut off from AC for hours at a
time (no solar, deprioritized) with nothing else stopping its own battery
from draining down to zero while it keeps powering whatever it's actually
plugged into (e.g. a real refrigerator). At/below `GATED_CRITICAL_SOC_PERCENT`
(default 6%), `GatedBatteryDriver` opens the gate and charges at whatever
wattage it's given (normally the hardware's own minimum) regardless of
solar availability or priority order - this overrides everything else. It
stays forced open until SOC climbs back up to the higher
`GATED_RECOVERY_SOC_PERCENT` (default 20%), not the same 6% line - without
that gap, a SOC sitting right at the critical threshold would flip the
plug on/off every single poll cycle. This means `setChargeLimit` must run
every cycle even when the requested wattage hasn't changed (the loop no
longer skips "unchanged" calls, since a gated device's actual decision can
depend on live SOC alone).

Confirmed live: with 冷蔵庫's TOU schedule set to "オフピーク" (which would
otherwise keep charging from AC no matter what wattage is requested - see
"Known caveats"), restarting with the gate in place correctly cut AC and
`acInputWatts` in `data/state.json` dropped from ~198W to 0.

## Architecture: adding another battery/charger vendor

`packages/core`'s control loop and allocator never talk to
`NativeAnkerClient` directly - they depend only on the `BatteryDriver` port
(`packages/core/src/battery/battery-driver.ts`):

```ts
type BatteryDriver = {
  getStatus(sn: string): Promise<Result<BatteryStatus>>;
  setChargeLimit(sn: string, watts: number, acOn?: boolean): Promise<Result<void>>;
};
```

Anything that can fail returns a `Result<T, E extends Error = Error> = T |
E` (`packages/core/src/result.ts`) instead of `T | undefined`/`boolean` -
the simplest error-branching shape available: a success value or a plain
`Error` instance, narrowed via `instanceof`/`in`. No wrapper object, no
class hierarchy - errors that need to carry typed extra data (e.g.
`AccountLockedError`'s `retryAfterMinutes` in `packages/anker/src/http-api.ts`)
are plain `Error`s tagged with a discriminant `kind` field
(`Object.assign(new Error(...), {kind: "...", ...fields})`) rather than
subclassed.

Adapters are written as factories, not classes: `export const Thing =
(props) => { ...local consts/closures for private state...; return {
...only the methods the port needs... }; }`, each returned method typed
against the port (`BatteryDriver["getStatus"]`) so drifting from the
interface is a type error. See `packages/anker/src/native-anker-client.ts`
or `packages/tuya/src/solar-source.ts` for real examples.

`NativeAnkerClient` (`packages/anker`) is the one adapter implementing
`BatteryDriver` today. To add a second brand: create a new
`packages/<vendor>` implementing it the same way (depending on
`@soltrk/core` for the port type, nothing else), register an instance of it
in `packages/cli/src/battery/registry.ts` under a vendor key, and tag that
battery's `data/priority.json` entry with `"vendor": "<your key>"`. No
changes needed in `packages/core`. The same pattern applies to solar
sources via the `SolarSource` port if you ever add a second panel/inverter
integration.

## Development

`./packages` is bind-mounted into the container, but nothing auto-reloads
on save - deliberately not `tsx watch`, since that restarts the whole
process (including a fresh Anker cloud login) on every file change, which
tripped Anker's own sign-in lockout more than once during heavy editing.
Type-check and test via the `app` service (a throwaway container per
invocation, never left running) as you go:

```
docker compose run --rm app npx tsc --noEmit
docker compose run --rm app npm test
```

then `docker compose restart soltrk` once you actually want the running
system to pick up the change. A full rebuild (`docker compose build`) is
only needed after changing a `package.json` (workspace or dependency
changes) or the `Dockerfile`.

TypeScript compiles as a single program from the root `tsconfig.json`
(`include: ["packages/*/src"]`) rather than per-package builds -
npm workspaces here is purely for dependency/import-boundary clarity
(`@soltrk/core`, `@soltrk/anker`, `@soltrk/tuya`, `@soltrk/cli`), not
independent compilation.

The test suite cross-validates crypto against the Python reference
implementation with a fixed key, and protocol encode/decode against real
captured payloads - see `packages/anker/src/*.test.ts`.
