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
```

Full setup (Tuya local keys, Anker credentials, `data/devices.json`, the optional smart-plug AC cutoff) is in README.md's "One-time setup" — read it before touching device onboarding.

## Working on the live system

The real deployment runs on a Raspberry Pi (`yao@pi0.local:~/soltrk/`), not on this machine. `./packages` is bind-mounted into the container, so deploying a code change means `scp`-ing the changed files there and then `docker compose up -d --build soltrk`. Note that `tsconfig.json`, `package.json` and the `Dockerfile` are `COPY`'d at image build time rather than mounted, and `.env` changes need `--force-recreate` (a plain `up -d` can report "Running" as a no-op).

Three standing constraints on that:

- **Ask before deploying.** Restarting the container interrupts a control loop managing real household power. Passing tests is not permission — get an explicit yes each time, and don't carry one deploy's approval over to the next.
- **Prefer night for anything risky.** Container restarts and exploratory changes lose generation if done mid-afternoon.
- **Minimize Anker cloud logins.** Every `docker compose run --rm` one-off logs in again from scratch, and too many logins from one IP risks getting it throttled (`account_locked` is already handled in `native-anker-client.ts`). Verify protocol changes with unit tests against the encoded bytes, batch live checks into a single script run, and read the long-running container's logs or `data/state.json` instead of spawning containers when that would answer the question.

Type-checking, tests, reading logs and `data/state.json` over SSH are all ordinary work and need no approval — none of it disturbs the running system.

## Architecture

Ports-and-adapters monorepo (npm workspaces), same shape as the sibling `picomanager` project:

- **`packages/core`** — vendor-neutral domain only: the `BatteryDriver`/`SolarSource` ports, the balance-evaluation allocator (`control/allocator.ts`), and the control loop (`control/loop.ts`). Never imports Anker or Tuya code.
- **`packages/anker`**, **`packages/tuya`** — the adapters. `NativeAnkerClient` is a from-scratch reverse-engineered client (cloud login, AWS IoT MQTT, hand-decoded A1765 wire format) since no community library supports this device; Tuya reads two GTB-800 microinverters over the *local* protocol, no cloud.
- **`packages/cli`** — composition root: env parsing (`config.ts`), the vendor registry wiring adapters into `BatteryDriver`/`SolarSource` (`battery/registry.ts`), and the `soltrk` CLI entrypoint.

A single root `tsconfig.json` (`include: ["packages/*/src"]`) type-checks every package as one program — workspaces exist for import-boundary clarity (`@soltrk/core` etc.), not independent compilation.

**No build step.** `tsc` runs with `noEmit: true` for type-checking only; the container and `npm run dev` both execute TypeScript directly via `tsx` (which uses esbuild's own parser — the installed `typescript` version only affects `tsc --noEmit`, never runtime).

**Charging decision, every poll cycle:** the allocator evaluates every non-full battery as a hypothetical active candidate — `request = solar − (every other unit's measured AC input) − this unit's own measured household load − ~33W conversion overhead` — and whichever feasible candidate leaves the smallest leftover balance wins and becomes the one active charging target this cycle. A candidate's score also gets a virtual watt bonus the lower its SOC is (`SOC_URGENCY_BONUS_WATTS_PER_PERCENT`), so a low-SOC unit can win — even with a nominally infeasible request — ahead of a peer that's already drawing most of the solar; the previous cycle's winner additionally gets a flat sticky bonus so two closely-matched candidates don't flip the active unit every single cycle. None of this is fairness/ordering logic — a unit that never wins is protected by a separate, independent safety net: below `GATED_DISCHARGE_FLOOR_SOC_PERCENT`, `GatedBatteryDriver` stops letting a gated unit run on its battery at all, replacing `battery` with `passthrough` so its load comes off AC instead. That's the whole override — it does not pin the unit to passthrough, and `charge` still passes through, which is the only thing that raises SOC again (passthrough holds it level). Discharging resumes as soon as SOC is back above the floor; there's deliberately no second, higher release threshold, since passthrough holds SOC level rather than raising it and so there's little to flap against.

**Solar covers loads before it charges:** each cycle the allocator first hands AC to units emptiest-battery-first for as long as the solar budget lasts — only the remainder goes to charging the one winning unit. A full unit sorts last and so is the first to be left on its own battery, which is correct: it has the most to spare. Charging never happens while some unit is still on its battery: a load the leftover can't quite cover is covered anyway and the shortfall imported, since paying a charge overhead plus a discharge loss to move the same energy is always worse. Below the charge threshold (`chargeLimitMin` + the 33W overhead, derived by `minSolarToChargeWatts()` rather than configured) there's no charge to displace, so the unit just stays on its battery. This is net-neutral on stored energy (the watts the charger gives up are watts the others would have drawn from their batteries) but skips a whole discharge/recharge round trip of conversion loss and cycle wear.

**Three AC states, not two** (`AcMode` in `core/src/battery/battery-driver.ts`): `charge` (plug closed, usage mode `STANDARD`, charges at the requested wattage plus ~33W overhead), `passthrough` (plug closed, usage mode `TIME_OF_USE`, feeds the unit's own load straight from AC with *no* charging and no overhead — measured AC in exactly equals AC out), and `battery` (plug open, unit runs its load off its own battery). Passthrough depends on each unit having an all-day MID_PEAK TOU schedule stored on it, set by hand in the Anker app once — soltrk can only switch the usage mode (`encodeSetUsageMode`), not write the schedule, which is cloud-gated. Units silently fall back to `STANDARD` whenever AC or Wi-Fi drops, so the usage mode is re-sent every cycle rather than cached. See README's "Lossless passthrough via TOU MID_PEAK" for the full derivation and live measurements.

**Error handling:** anything fallible returns `Result<T, E extends Error = Error> = T | E` (`core/src/result.ts`) — narrow with `instanceof`/`in`, never a wrapper object. Errors needing typed extra data are plain `Error`s tagged with a discriminant `kind` field, not subclassed.

**Adapters are factories, not classes:** `export const Thing = (props) => { /* closures for private state */ return { /* only the port's methods */ }; }`, each method typed against the port so drift is a type error (see `native-anker-client.ts`, `solar-source.ts`).

**File naming is kebab-case** throughout (`gated-battery-driver.ts`, not `GatedBatteryDriver.ts`).

See README.md for the full protocol reverse-engineering notes, known hardware caveats (the charge-wattage command is approximate and can't reach true zero — hence the smart-plug cutoff), and how to add a new battery/solar vendor.
