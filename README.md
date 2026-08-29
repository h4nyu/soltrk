# soltrk

Keeps 2x GTB-800 plug-in solar microinverters (880W total) from backfeeding
the grid by routing their output into up to N Anker SOLIX portable power
stations, charged one at a time - whichever unit's charging would leave the
grid balance closest to zero this cycle (unit fills to 100% SOC, then the
next-best unit takes over).

## Layout

An npm workspaces monorepo, split by layer (ports/business logic vs.
adapters), the same shape as the sibling `picomanager` project:

- **`packages/core`** - the vendor-neutral domain: the `BatteryDriver` and
  `SolarSource` ports, the balance-evaluation allocator, and the control loop
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
  There's no fixed charge order between units - every cycle, each
  not-yet-full unit is evaluated as the hypothetical *active* charging
  target: charge at the current solar output *minus whatever the other
  units are already measured to be drawing* (their passthrough draw, or a
  full unit's - see below) *minus that unit's own
  measured household load* (`acOutputWatts`, known up front regardless of
  whether its AC input is on) *minus a fixed ~33W conversion overhead*,
  capped at the hardware max (1200W). Whichever feasible unit leaves the
  smallest (non-negative) leftover balance wins and becomes active this
  cycle - in practice, a unit with little or no load of its own reaches
  100% quickly and hands the turn to the next-best unit on its own, so there's
  no need to separately track fairness or ordering. A unit that must never be
  allowed to run dry (e.g. one powering an actual refrigerator) is protected
  by the discharge floor below, not by charging order. No gradual
  ramp-up: an earlier version ramped the request, but once it's capped at
  actual solar the ramp just added lag, and real solar changes gradually
  enough on its own (observed: roughly an hour from 0 to peak in the
  morning). Every non-active unit idles at the hardware's minimum request
  (100W - there's no real "0W/off", see below);
  whether it's actually *connected* to AC is a separate per-unit decision.
  **Solar covers household loads before it charges anything**: while there's
  any solar, units are connected emptiest battery first for as long as the
  budget lasts, so when there isn't enough to go round the units with the
  least charge to spare are the last to be left on their own batteries - and
  a full one is the first, having the most to spare. A unit measuring no
  load is connected too: it draws nothing and costs no budget, and its load
  is only zero until someone switches something on, which a unit already on
  AC covers from the first watt instead of discharging until the next poll
  notices. Everything the budget doesn't reach is disconnected and runs off
  its own battery (see the smart-plug section under One-time setup).

  Covering loads first costs the charger nothing in net terms - the watts it
  gives up are watts the other units would otherwise have pulled out of
  their own batteries - while avoiding a whole discharge/recharge round trip
  of conversion loss and cycle wear. Taken to its conclusion, **charging
  never happens while some unit is still on its battery**: the budget a unit
  has to see before it's connected is
  `min(its load, minSolarToChargeWatts)`.

  That threshold reads most easily as a **buffer zone**. Solar below it
  can't start a charge, so it is simply absorbed
  by the house and never has to be accounted for. Budget *above* that line
  is the part with somewhere else to go, and letting a load take it beats
  charging with it: covering costs `load - surplus`, charging instead costs
  `load - (surplus - overhead) x dischargeEfficiency`, which is worse for
  any values of the two. So a load bigger than the budget still connects,
  importing the shortfall, as long as there was chargeable budget to spend.
  Once the budget is down in the buffer zone there's no charge left to
  displace, and only a load that genuinely fits is worth connecting.

  Connecting a load inside that buffer zone is never a loss, which is why
  it's still done. If the house is drawing more than the solar, the two
  options come out identical: connecting imports the load but leaves the
  battery alone, not connecting imports less but drains the battery by the
  same amount, and that drain has to be bought back later. If the house is
  drawing less, connecting wins outright - the grid bill is unchanged, but
  not connecting spills the surplus while draining a battery for no reason.
  Since `HOUSE_STANDBY_WATTS` is only a floor and real house consumption
  isn't measured, there's no telling which case is in effect, so the
  behaviour that ties in one and wins in the other is the one to pick.

### Reverse engineering a new command

Every write command so far (`set_charge_limit`, `realtime_trigger`) was
found the same way, without any TLS interception (mitmproxy etc.) - AWS IoT
just lets our own MQTT session subscribe to the *app's own* publish topic,
not only the device's:

1. Run `docker compose run --rm app soltrk capture-mqtt <device_sn>`
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
endpoint has never been found.

The lesson learned working around that, though, is worth repeating when a
command seems cloud-only: **a captured message is not necessarily one
command.** Msgtype `0x0090` turned out to carry three separate commands
distinguished only by which TLV fields are present, and while the schedule
write among them really is cloud-gated, the usage mode sharing the same
message type is not - sending a deliberately *smaller* subset of the
captured message's fields (`encodeSetUsageMode`, field `a2` only) works over
plain MQTT and was enough to get the behaviour we actually wanted. Before
concluding a message type is unusable, check whether some subset of its
fields is a command in its own right; cross-checking against
[`anker-solix-api`](https://github.com/thomluther/anker-solix-api)'s
`mqttmap.py` / `mqttcmdmap.py` (which model exactly this
one-message-type-many-commands structure, and mark the cloud-only ones) is
the fastest way to find out.

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

### Lossless passthrough via TOU MID_PEAK

Each unit has three distinct AC states, not two (`AcMode` in
`packages/core/src/battery/battery-driver.ts`):

| state | smart plug | usage mode | effect |
| --- | --- | --- | --- |
| `charge` | closed | `STANDARD` | charges at the requested wattage, +~33W overhead |
| `passthrough` | closed | `TIME_OF_USE` | feeds its own load from AC, **no charging, no overhead** |
| `battery` | open | (n/a) | runs its own load off its battery |

`passthrough` exists because charging is not free: measured on real
hardware, `AC in - AC out - requested watts` is consistently ~25-33W, which
is where `CHARGE_CONVERSION_OVERHEAD_WATTS` comes from. A unit that shouldn't
charge right now, but also shouldn't drain its battery powering a fridge,
wants neither `charge` nor `battery`.

**Setup (manual, once per unit).** In the Anker app, set the unit's TOU
schedule to a single all-day **MID_PEAK** period (00:00-24:00). All three
units in this deployment are configured this way and left that way. This is
the one step soltrk can't do itself - see below.

**How soltrk drives it.** With that schedule stored on the device, the
usage mode alone selects the behaviour, and *that* is settable over plain
MQTT (`encodeSetUsageMode`, msgtype 0x0090 carrying only field `a2`):
`TIME_OF_USE` follows the stored MID_PEAK schedule and charges nothing,
`STANDARD` makes `setChargeLimit` effective again. Verified live on one
unit, switching cleanly in both directions:

```
stored MID_PEAK :  in  90W / out 90W  -> difference   0W   (passthrough)
sent STANDARD   :  in 162W / out 96W  -> difference +65W   (charging resumed)
sent TIME_OF_USE:  in  90W / out 90W  -> difference   0W   (back to passthrough)
```

**Why only field `a2` works.** Msgtype 0x0090 is a group of three commands
sharing one message, distinguished by which fields are present. Field `a2`
alone is the usage mode and goes over MQTT normally. Fields `a2`+`a3`+`a4`+
`a6`+`a7` together are the *schedule* write, and `a7` (the schedule itself,
encoded `(tariff(1=Peak, 2=Mid, 3=Off), start_hr, end_hr)` per slot) only
takes effect through an Anker cloud HTTP endpoint that has never been
identified - the app calls that endpoint, and the MQTT message we can see is
just the cloud relaying it downstream afterward. That's why
`encodeSetTouSchedule` in `protocol.ts` is decoded and byte-exact against
real captures yet does nothing when we publish it, while `encodeSetUsageMode`
works: the former includes `a7`, the latter deliberately doesn't. The
upstream [`anker-solix-api`](https://github.com/thomluther/anker-solix-api)
project's command map reaches the same conclusion independently, annotating
its `pps_tou_schedule` as a cloud command and leaving it disabled, while
enabling `pps_usage_mode` for this model.

**The mode is not sticky.** A unit drops out of `TIME_OF_USE` back to
`STANDARD` by itself whenever it loses grid power or Wi-Fi - the app says so
explicitly ("TOUモードを終了しました … 電力モードは[標準モード]に切り替わり
ました"). Since a gated unit loses grid power every time its plug opens, the
usage mode is re-sent every cycle rather than cached, exactly like the
wattage command.

**Consequence for the discharge floor.** The floor in `GatedBatteryDriver`
switches a unit to `passthrough`, not `charge`: its job is to stop a battery
draining, and passthrough does that by powering the unit's load from AC
directly - without buying grid power to push into a battery, and without
paying the conversion overhead to do it. A unit below the floor therefore
holds its SOC steady rather than climbing; refilling it is left to the
allocator once there's solar to do it with. The floor never downgrades a
unit the allocator already picked to charge.

## Known caveats

- **Small charges are mostly loss.** The ~33W conversion overhead is near
  enough fixed whatever the rate, so charging at 50W costs 83W to deliver
  (60% efficient, ~54% once the discharge loss is counted), against 75% at
  100W and 86% at 200W. `chargeLimitMin` (100W) is therefore the least
  charge worth *starting*, not a hardware limit - the app's own slider stops
  at 100W but a live test took the API down to 1W and found sub-100W
  requests do scale the real charge current proportionally.

  It used to be pushed as low as the hardware would tolerate, because a
  device that shouldn't charge still had to be sent *some* wattage - there
  was no way to say zero. Passthrough says zero properly now, so the only
  remaining pressure on this value is upward. What caps it is that it also
  sets the solar needed before charging starts at all
  (`minSolarToChargeWatts()` in `allocator.ts`: this plus the 33W overhead,
  with household loads and `HOUSE_STANDBY_WATTS` on top, so roughly 278W of
  panel output at 100W) - raise it too far and an overcast day never charges
  anything. Note that surplus which doesn't charge isn't wasted: it's
  absorbed by the house at 1:1, which beats storing it at 60%.

  That threshold is derived rather than configured, because the two move
  together by definition. When it *was* a separate setting, lowering
  `chargeLimitMin` left it stranded at the old value and solar that could
  have been charged with went unused until someone noticed.

  `HOUSE_STANDBY_WATTS` is that constant house load - the part soltrk never
  sees, since it only meters what's behind the battery units. That much of
  solar is treated as already spoken for and doesn't need covering by the
  charger. What's wanted is the floor the house *never* dips below, not its
  average, so only loads that genuinely never switch off count; lighting
  doesn't, however reliably it gets used. Leave at `0` (default) if unsure;
  setting it too high is what could actually cause backfeed.

  **Measuring it without a meter.** The electricity retailer's own app
  (Octopus here) plots smart-meter consumption per hour, and any day the
  house was empty reads out the floor directly. Two such days:

  - 2026-02-12, before the batteries: 1.60 kWh total, with bars at 0.10
    kWh/h from 00:00-07:00 and 16:00-23:00 and *nothing at all* from
    08:00-15:00. 16 bars x 0.10 = 1.60 exactly.
  - 2026-07-08, batteries in service, every unit on battery all day: 2.90
    kWh, 0.10 kWh/h essentially flat across the whole 24h, rising to 0.20
    for the last two hours.

  So the floor is **100W**, about 2.4 kWh/day, against the 30W it had been
  guessed at. The setting is 80 rather than 100, deliberately a little under
  the measurement: the error directions aren't symmetric. Set it above the
  true floor and the allocator reserves solar the house won't actually take,
  and the remainder backfeeds. Set it below and it asks for a slightly
  larger charge than solar covers, which the house absorbs and the grid tops
  up - no export, and the only cost is the round-trip loss on those few
  watts. So the margin belongs on the low side. Taken to its conclusion that
  argues for lower still (in the replay, export over the period was 0.25 kWh
  at 30W against 0.56 at 80W and 0.76 at 100W), but every one of these
  differences is on the order of a yen a day, so the value is chosen to
  state the truth with a margin rather than to win a rounding error.

  Note that 100W is far more than
  the three 24h ventilation fans and three air purifiers it was assumed to
  be (those are a few watts and 5-15W each); 50-70W of it is unaccounted
  for, and finding it is worth more than anything the allocator does - 100W
  standing is about 33,000 yen a year, against the roughly 5,900 the whole
  passthrough rework saves.

  Two cautions on reading these charts. Check the bucket width before
  dividing: the bars are hourly here, confirmed by the total (16 bars of
  0.10 is 1.60; at half-hourly the same 16 hours would need 32 bars and
  total 3.20) and by measuring the plot - 16 bars evenly spaced 35px apart
  with a 313px gap, so 24 slots of which 8 are empty. And the reading is
  only the floor on a day with *no* solar reaching the house; the Feb 12
  daytime bars are absent precisely because solar cancelled the house load
  outright, which is what makes the empty-house night hours the number to
  use.

  Replaying 5.5 days of recorded profile through 0/15/30/50/80/110W showed
  everything from 0 to 50W landing within +-0.2 kWh of each other over the
  whole period - about 1 yen a day, and non-monotonic, so that window is
  noise rather than a curve with an optimum in it. Only 80W and above lost
  clearly, by holding back solar that then got exported for nothing (0.33 to
  1.89 kWh over the period, against 0.13 to 0.82 at 30W). That sweep is why
  the value isn't worth tuning - but it also assumed a constant house draw,
  which penalises high settings by exporting everything above it, so it
  argues for setting the measured floor rather than against it. Note the
  recorded period was overcast throughout and rarely had surplus, which is
  exactly when this setting does the least - a sunny stretch would separate
  the options more.
- **Unresolved: solar may not reach the house when every plug is open.**
  The two empty-house days above are close to a controlled experiment, and
  they don't agree. On 2026-02-12, before the batteries, the meter read
  *zero* for eight straight midday hours - solar cancelled the house load
  outright. On 2026-07-08, with the batteries in service and every unit on
  `battery` (so every plug open), the meter read the full 100W right through
  midday, in July, with a longer and stronger day. No cancellation at all.

  That is what you would see if the microinverters sit behind the smart
  plugs rather than on the house circuit: open every plug and their output
  has nowhere to go, so all solar is lost. It would mean `battery` is not
  the neutral "run on your own cells" state the allocator models it as, but
  also a decision to discard whatever is being generated. The recorded
  window can't settle it - the units were charging through every sunny hour,
  drawing almost exactly the solar being produced (551W generated against
  553W of AC input at 2026-08-24 11:00), so both wirings predict nearly the
  same meter reading. Ruling it out needs either the weather for 2026-07-08
  (a washout would explain the flat day innocently) or a deliberate test:
  force every unit to `battery` for an hour of real sun and watch the meter.
- **A plug can be switched by something other than soltrk.** The Tuya Smart
  Life app keeps its own automations and scenes, and any left over from
  before a plug was wired into soltrk will keep firing - turning the plug on
  independently of the control loop, with nothing in soltrk's logs, because
  soltrk never issued the command. Observed live: a gated unit drew AC for
  hours while the loop believed its plug was open, and it recurred until the
  stray rule was deleted in the app.

  This looks similar to the LAN flakiness below, so check the app's
  Automation/Scene tab for rules involving the plug before spending time on
  the flaky-command explanation. It can't be fixed from soltrk - the rule
  lives on Tuya's cloud side.

- **The requested wattage is a rough dial, not a precise one.** Real
  hardware doesn't reliably obey a specific requested wattage - a 100W
  request was observed drawing 137W on real hardware. `soltrk` treats the
  requested number as an approximate ceiling and steers by the measured
  balance instead (see "How it works"); the ~33W conversion overhead while
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
  the wattage command itself, in any mode. What *does* stop charging outright
  is the usage mode, see "Lossless passthrough via TOU MID_PEAK" below.
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
`state.json`/`devices.json` - it holds secrets, hence `data/` and not
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
docker compose run --rm app soltrk discover <id> <key>
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

To find your device serials:

```
docker compose run --rm app soltrk devices
```

**Note:** the Anker cloud allows only one active login per account at a
time - running this (or `soltrk` itself) will log the phone app out of that
account. It can just log back in; the two don't fight over it once both are
logged in independently.

### 4. Device list (`data/devices.json`)

`soltrk` re-reads `data/devices.json` every cycle, so it can be changed live
without restarting anything. There's no env-var seed for it (same reasoning
as Tuya's config file - it would just be a one-time default for a file
that's the live source of truth forever after) - create it directly, one
entry per battery:

```json
[
  { "sn": "APCDLRG0G06401641", "name": "冷蔵庫", "vendor": "anker-gated" },
  { "sn": "APCDLRG0G06400974", "name": "キッチン", "vendor": "anker" }
]
```

There's no charge order to configure - see "How it works" for how the
allocator picks which unit charges each cycle. `name` is just for readable
logs/`status` output, and `vendor` selects which adapter in
`packages/cli/src/battery/registry.ts` talks to that serial (defaults to
`"anker"` if omitted - see Architecture below). Use `"anker-gated"` for any
sn with a physical AC-cutoff smart plug configured (step 6).

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
IP needed), then confirm its switch dp with the same `soltrk discover`
command used for the panels:

```
docker compose run --rm app soltrk discover <id> <key>
```

`"1"` is the standard boolean on/off dp for most Tuya plugs and is the
default if a plug entry omits `"switchDp"`. Then add to `data/tuya.json`'s
`"plugs"` array:

```json
{ "id": "...", "key": "...", "gatesSn": "APCDLRG0G06401641" }
```

(`gatesSn` is the battery this plug's output feeds), and set that
battery's `vendor` to `"anker-gated"` in `data/devices.json` (step 4).
`GatedBatteryDriver` (`packages/cli/src/battery/gated-battery-driver.ts`)
then cuts the plug whenever the allocator doesn't pick that battery as this
cycle's active target, and restores it (plus still sending the normal
wattage command for fine control) whenever it is - any sn with no matching
plug entry is unaffected and behaves exactly like plain `"anker"`.

**Discharge floor:** a gated device can be cut off from AC for hours at a
time (no solar, not this cycle's pick) with nothing else stopping its own
battery from draining down to zero while it keeps powering whatever it's
actually plugged into (e.g. a real refrigerator). Below
`GATED_DISCHARGE_FLOOR_SOC_PERCENT` (default 10%), `GatedBatteryDriver`
stops letting it run on its battery: `battery` becomes `passthrough`, so
the plug closes and its load is fed from AC instead.

That is the entire override - it removes `battery` as an option, it does
not pin the device to `passthrough`. `charge` still passes straight
through, and is the only thing that raises the SOC again, since passthrough
holds it level. So the sequence is: floor → passthrough (stop draining) →
charge (SOC recovers, once there's solar) → discharging allowed again as
soon as it's back above the floor.

There's deliberately no second, higher threshold to release at: the
condition is just "is it above the floor", evaluated fresh from the current
SOC each cycle, with no memory of which side it came from. Hysteresis would
normally guard against flapping at the line, but there's little to flap
here - passthrough holds SOC level rather than raising it, so a device that
hits the floor stays put until something actually charges it, which only
happens when there's solar to spare. An unreadable SOC leaves the
allocator's own decision standing, since the floor is a claim about how
empty the battery is and there's nothing to base it on.

Passthrough rather than a forced charge is deliberate: it costs only the
device's own load off the grid, with no ~33W conversion overhead and
nothing bought to push into the battery.

This means `setChargeLimit` must run every cycle even when the requested
wattage hasn't changed (the loop no longer skips "unchanged" calls, since a
gated device's actual decision can depend on live SOC alone).

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
battery's `data/devices.json` entry with `"vendor": "<your key>"`. No
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
