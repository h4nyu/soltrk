# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Everything runs inside Docker (`network_mode: host` is required for Tuya's UDP device discovery, which isn't reliable outside a native Linux host — see the "Docker on macOS" note below). The `app` service is a throwaway container per invocation (never left running); `soltrk` is the real, long-running control loop service.

```sh
# Type-check (no build step exists — see "No build step" below)
docker compose run --rm app npx tsc --noEmit
# or: docker compose run --rm app npm run typecheck

# Run the full test suite
docker compose run --rm app npm test

# Run a single test file
docker compose run --rm app npx tsx --test packages/core/src/control/allocator.test.ts

# Discover a Tuya device's dp codes (power sensor scale, plug switch dp)
docker compose run --rm app soltrk discover <id> <key>

# List Anker device serials bound to the account (for data/devices.json)
docker compose run --rm app soltrk devices

# Start/restart the live control loop
docker compose up -d soltrk
docker compose restart soltrk        # after an edit — nothing auto-reloads
docker compose up -d --build soltrk  # after touching package.json or Dockerfile

# Inspect live state
cat data/state.json
docker compose exec soltrk soltrk status

# Roll completed days into data/summaries/ and delete raw days past retention.
# The `scheduler` service does this nightly; this is the manual/one-off form.
make summarize

# Dashboard - read-only web UI over data/state.json and the history logs.
# Shares the soltrk image; only the command differs.
make web                             # rebuild the bundle, then start it (:8080)
make web-build                       # just rebuild packages/web/dist
docker compose up -d web             # never `--build` - see the compose comment

# The Makefile wraps the incantations above; `make typecheck` runs both tsc
# passes (the root program and the browser half), `make test` the suite.
npx tsx packages/web/src/index.ts    # API server for local UI development
npm --prefix packages/web run dev    # Vite dev server with HMR, proxies /api to it
```

Full setup (Tuya local keys, Anker credentials, `data/devices.json`, the optional smart-plug AC cutoff) is in README.md's "One-time setup" — read it before touching device onboarding.

## Working on the live system

The real deployment runs on a Raspberry Pi (`yao@pi0.local:~/soltrk/`), not on this machine. `./packages` is bind-mounted into the container, so deploying a code change means `scp`-ing the changed files there and then `docker compose up -d --build soltrk`. Note that `tsconfig.json`, `package.json` and the `Dockerfile` are `COPY`'d at image build time rather than mounted, and `.env` changes need `--force-recreate` (a plain `up -d` can report "Running" as a no-op).

Three standing constraints on that:

- **Ask before deploying, every time.** Restarting the container interrupts a control loop managing real household power. Passing tests is not permission. Get an explicit yes, and don't carry one deploy's approval over to the next — including small follow-ups to something already deployed.

  A deploy is one operation, not a sequence of separately-approved commands. Once there is a yes, `scp`-ing the files, editing the Pi's `.env` and rebuilding are all inside it: say which commands are about to run when asking, then carry the whole thing through instead of stopping to re-ask between them. What a yes does *not* cover is a different change than the one described, or the next deploy later on.
- **Prefer night for anything risky.** Container restarts and exploratory changes lose generation if done mid-afternoon.
- **Minimize Anker cloud logins.** Every `docker compose run --rm` one-off logs in again from scratch, and too many logins from one IP risks getting it throttled (`account_locked` is already handled in `native-anker-client.ts`). Verify protocol changes with unit tests against the encoded bytes, batch live checks into a single script run, and read the long-running container's logs or `data/state.json` instead of spawning containers when that would answer the question.

Type-checking, tests, reading logs and `data/state.json` over SSH are all ordinary work and need no approval — none of it disturbs the running system.

**Reaching the Pi.** `pi0.local` resolves over mDNS, which has silently stopped working from the development machine for hours at a stretch while the Pi itself was perfectly healthy — the symptom is `Could not resolve hostname pi0.local`, and it says nothing about the control loop. The LAN address is `192.168.1.34`; prefer an SSH host alias pinned to that IP so monitoring survives an mDNS outage.

**The Pi's `~/soltrk` is not a normal checkout — never run a git command there that writes to the working tree.** Because deploying means `scp`-ing files over it, the checkout sits on whatever commit it was cloned at (`main`, long stale) with the entire deployed diff showing as uncommitted modifications, and it has no credentials to fetch. Those "modified" files *are* the running system: `./packages` is bind-mounted into the container. `git checkout`, `restore`, `stash`, `reset`, `clean` or `pull` there would instantly revert the live control loop to months-old code. `git status`, `git log` and `git diff` are safe. To check what is actually deployed, compare file hashes against the local branch instead:

```sh
ssh pi0 'cd ~/soltrk && find packages docker-compose.yml -type f ! -name "._*" | sort | xargs md5sum'
```

(`._*` files are macOS AppleDouble junk left by `scp` and can be ignored.)

## Architecture

Ports-and-adapters monorepo (npm workspaces), same shape as the sibling `picomanager` project:

- **`packages/core`** — vendor-neutral domain only: the `BatteryDriver`/`SolarSource` ports, the balance-evaluation allocator (`control/allocator.ts`), and the control loop (`control/loop.ts`). Never imports Anker or Tuya code.
- **`packages/anker`**, **`packages/tuya`** — the adapters. `NativeAnkerClient` is a from-scratch reverse-engineered client (cloud login, AWS IoT MQTT, hand-decoded A1765 wire format) since no community library supports this device; Tuya reads two GTB-800 microinverters over the *local* protocol, no cloud.
- **`packages/cli`** — composition root: env parsing (`config.ts`), the vendor registry wiring adapters into `BatteryDriver`/`SolarSource` (`battery/registry.ts`), and the `soltrk` CLI entrypoint.
- **`packages/web`** — the dashboard, and the one part of the repo that is not part of the control path. It reads only the files the loop already writes (`data/state.json`, `data/history.jsonl`), mounts `./data` read-only, and opens no device connection. It needs no image of its own: `packages` is both `COPY`'d into the soltrk image and bind-mounted over it at runtime, so the `web` compose service is the same image as `app` and `soltrk` with a different `command:` — the pattern those two already use. The one rule is **never `docker compose up --build web`**: `web` is written out rather than merging the `x-app` anchor precisely so it carries no `build:` section, because rebuilding that shared image is another Anker cloud login.

A single root `tsconfig.json` (`include: ["packages/*/src"]`) type-checks every package as one program — workspaces exist for import-boundary clarity (`@soltrk/core` etc.), not independent compilation.

**No build step.** `tsc` runs with `noEmit: true` for type-checking only; the container and `npm run dev` both execute TypeScript directly via `tsx` (which uses esbuild's own parser — the installed `typescript` version only affects `tsc --noEmit`, never runtime).

`packages/web` is the exception, and only for its browser half. `packages/web/client` is bundled by Vite into `packages/web/dist`, which the server then serves as static files; its Node server in `packages/web/src` still runs straight from TypeScript via `tsx` like everything else. The bundle is built by `make web-build`, which runs vite inside a throwaway `app` container. It installs with `--no-workspaces` on purpose: that puts `node_modules` under `packages/web`, which is bind-mounted, so it survives on the host between runs — a plain `npm install` would resolve to the workspace root inside the image and be thrown away with the container every time. Vite is therefore never added to the soltrk image, which would mean editing the `Dockerfile` and rebuilding the loop. The client also needs its own `packages/web/tsconfig.json` — it targets the DOM and ES modules, so the root tsconfig's `include: ["packages/*/src"]` deliberately misses `client/`. **The root `tsc --noEmit` therefore does not type-check the browser code, and `vite build` does not either**; run `npx tsc -p packages/web --noEmit` for that. `packages/web` also imports nothing from `@soltrk/*` on purpose: `history.jsonl` is an append-only log whose schema has already drifted once (the oldest records carry `priority` and no `batterySoc`, `mode` or `acOutputWatts`), so a viewer of it must define its own tolerant, all-optional record types rather than share the writer's current `StateSnapshot`.

**Charging decision, every poll cycle:** the allocator evaluates every non-full battery as a hypothetical active candidate — `request = solar − (every other unit's measured AC input) − this unit's own measured household load − ~33W conversion overhead` — and whichever feasible candidate leaves the smallest leftover balance wins and becomes the one active charging target this cycle. A candidate's score also gets a virtual watt bonus the lower its SOC is (`SOC_URGENCY_BONUS_WATTS_PER_PERCENT`), so a low-SOC unit can win — even with a nominally infeasible request — ahead of a peer that's already drawing most of the solar; the previous cycle's winner additionally gets a flat sticky bonus so two closely-matched candidates don't flip the active unit every single cycle. None of this is fairness/ordering logic — a unit that never wins is protected by a separate, independent safety net: below `GATED_DISCHARGE_FLOOR_SOC_PERCENT`, `GatedBatteryDriver` stops letting a gated unit run on its battery at all, replacing `battery` with `passthrough` so its load comes off AC instead. That's the whole override — it does not pin the unit to passthrough, and `charge` still passes through, which is the only thing that raises SOC again (passthrough holds it level). Discharging resumes as soon as SOC is back above the floor; there's deliberately no second, higher release threshold, since passthrough holds SOC level rather than raising it and so there's little to flap against. An SOC that can't be read counts as below the floor — the first cycle after a restart has no Anker status yet, and deferring to the allocator there was observed handing all three units back to their batteries at 6–10%.

**Solar covers loads before it charges:** each cycle the allocator first hands AC to units emptiest-battery-first for as long as the solar budget lasts — only the remainder goes to charging the one winning unit. A full unit sorts last and so is the first to be left on its own battery, which is correct: it has the most to spare. Charging never happens while some unit is still on its battery: a load the leftover can't quite cover is covered anyway and the shortfall imported, since paying a charge overhead plus a discharge loss to move the same energy is always worse. Below the charge threshold (`chargeLimitMin` + the 33W overhead, derived by `minSolarToChargeWatts()` rather than configured) there's no charge to displace, so the unit just stays on its battery. This is net-neutral on stored energy (the watts the charger gives up are watts the others would have drawn from their batteries) but skips a whole discharge/recharge round trip of conversion loss and cycle wear.

**Three AC states, not two** (`AcMode` in `core/src/battery/battery-driver.ts`): `charge` (plug closed, usage mode `STANDARD`, charges at the requested wattage plus ~33W overhead), `passthrough` (plug closed, usage mode `TIME_OF_USE`, feeds the unit's own load straight from AC with *no* charging and no overhead — measured AC in exactly equals AC out), and `battery` (plug open, unit runs its load off its own battery). Passthrough depends on each unit having an all-day MID_PEAK TOU schedule stored on it, set by hand in the Anker app once — soltrk can only switch the usage mode (`encodeSetUsageMode`), not write the schedule, which is cloud-gated. Units silently fall back to `STANDARD` whenever AC or Wi-Fi drops, so the usage mode is re-sent every cycle rather than cached. See README's "Lossless passthrough via TOU MID_PEAK" for the full derivation and live measurements.

**`SolarSource` reports watts per panel, not just a total.** The port's one method is `getWattsByPanel(): Record<string, number>` (`core/src/solar/solar-source.ts`), keyed by each panel's configured name (`gtb800-1`, `gtb800-2`, ...); `totalSolarWatts` is derived by summing it in `loop.ts` rather than being a second thing the adapter has to keep consistent with the breakdown. A panel is simply absent from the map when it has never reported or its reading has gone stale - never present at 0 - which is the same freshness rule `getTotalWatts` used to apply to the sum, now applied once in one place instead of duplicated between a total and a breakdown that could disagree. `StateSnapshot.solarByPanel` carries this into `data/state.json` and the history log for free, since both already serialise the whole snapshot. Tracking started 2026-09-22 - **older history and summaries have no panel breakdown**, and the dashboard's per-panel chart (and `cli/summary.ts`'s hourly panel folding, keyed by name rather than a positional index since a panel's name already is its identity) simply have nothing to show before that; there was no backfill, by design.

**History is one file per local day, and gets rolled up.** The loop appends each cycle to `data/history-YYYY-MM-DD.jsonl`. One file per day rather than one growing file because the alternative cannot be pruned: pino holds the destination's file descriptor open for the life of the process, so renaming the file leaves the loop writing to the renamed inode, and rewriting it in place races with the append that lands every cycle. A completed day is never touched again by the loop, which is what makes `soltrk summarize` safe to run against a live system.

`soltrk summarize` (nightly from the `scheduler` service, or `make summarize` by hand) folds completed days into `data/summaries/YYYY-MM.json` and then deletes raw files that are **both** recorded in a summary and past the retention window - two independent conditions, so nothing is deleted that has not survived somewhere else. It is idempotent: the day currently being written is skipped, and a file already listed in a month's `sources` is not folded again. That bookkeeping is per source **file**, not per day, which matters exactly once: on the day the loop switched from the single growing `history.jsonl` to daily files, that day's cycles are split across both, and keyed by day the second one folded would be skipped and half the day lost. The old log is folded like any other source - across every month it spans - and deleted once its last record (its mtime, since nothing writes to it after the switch) is past the window. Summaries hold one entry per hour, and every figure in them is a `[sum, count]` pair rather than a mean. That is what lets the dashboard put raw 30s cycles and hourly aggregates in the same chart bucket and still get the right number - an hour standing for 120 cycles has to weigh 120 times as much as a single cycle, and only a count can say so. Averaging each source and then averaging the averages quietly mis-weights the boundary bucket.

Because the raw logs remain the source of truth until they are deleted, a summary is re-derivable: delete `data/summaries/` and re-run, and any month whose raw days still exist is rebuilt. That is also why the cron job failing for a night costs nothing.

**The rollup runs in its own container.** The `scheduler` compose service is the soltrk image with a third command (`soltrk schedule`), and exists so the nightly rollup - which reads a day of JSONL and builds a month of accumulators - runs nowhere near the control loop. Host cron would work too, but then the schedule lives outside the repository and is forgotten the next time the Pi is rebuilt. The sibling picomanager project settled on a dedicated `scheduler` service for the same reason, and this deliberately uses the same library (`node-schedule`) so there is one scheduler to know across both repos. Two things picomanager learned the hard way are handled here: node-schedule has no overlap guard, so one is added; and its in-process schedule is disposable across restarts, which here costs nothing because the filesystem already is the durable state - the raw files that still exist, and the `sources` each summary lists, decide exactly what remains - so the job just runs once at startup and catches up whatever a stopped Pi missed. `SUMMARIZE_CRON` and `SUMMARIZE_RETENTION_DAYS` configure it; an unparseable expression exits rather than starting a container that quietly never fires.

**Timestamps are UTC; only calendar boundaries are local.** Everything stored, compared or sent to the browser is a UTC instant. The timezone is consulted only to decide *which day or month* something belongs to. It has to be given explicitly through `TZ` (docker-compose.yml defaults it to this deployment's own zone): a container has no system timezone to inherit, an empty `TZ` resolves to `Etc/Unknown` rather than falling back, and bind-mounting the host's `/etc/localtime` does not help either - Docker resolves the symlink, and Node's ICU can then no longer derive a zone name from the path and falls back to UTC (verified on the Pi). Getting this wrong is not cosmetic: the container's own clock is UTC, where the day boundary lands at 09:00 in Japan and would cut every solar day in half.

**The dashboard's reader is columnar, and windows relative to the data.** A cycle held as an object plus per-device arrays measured about 3KB and had the dashboard at 95MB for two weeks of history on a 905MB machine; the same cycle as twenty numbers across parallel arrays is about 160 bytes. Which files it opens is decided relative to the newest day present, not to the clock - measuring from the clock looks equivalent and is not, because if the loop has been stopped for longer than the retention window every file falls outside it and the dashboard goes blank exactly when someone is trying to find out what happened. Ranges longer than the raw window are served from the monthly summaries, and the page says so rather than passing an hourly average off as 30-second data.

**Error handling:** anything fallible returns `Result<T, E extends Error = Error> = T | E` (`core/src/result.ts`) — narrow with `instanceof`/`in`, never a wrapper object. Errors needing typed extra data are plain `Error`s tagged with a discriminant `kind` field, not subclassed.

**Adapters are factories, not classes:** `export const Thing = (props) => { /* closures for private state */ return { /* only the port's methods */ }; }`, each method typed against the port so drift is a type error (see `native-anker-client.ts`, `solar-source.ts`).

**File naming is kebab-case** throughout (`gated-battery-driver.ts`, not `GatedBatteryDriver.ts`).

See README.md for the full protocol reverse-engineering notes, known hardware caveats (the charge-wattage command is approximate and can't reach true zero — hence the smart-plug cutoff), and how to add a new battery/solar vendor.
