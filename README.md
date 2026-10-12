# devhost

Turn a fresh Apple Silicon Mac mini into an always-on, headless development server for Claude Code, in one idempotent command, and keep it that way.

The work happens through Claude Code Remote Control, SSH and Tailscale; nobody sits at the Mac mini.

| Part | What | Status |
| --- | --- | --- |
| A | `devhost` CLI + collector (Mac mini) | **Phase 1 of 5 done**, waiting for review |
| B | devhost Desktop (macOS app on the MacBook) | not started |

Part A is built in phases, and each phase stops for review:

1. ✅ Contract package, config schema, `init`, runner, `apply --dry-run` with system + packages
2. ⬜ Docker, Tailscale, Claude Code install, settings merge, `CLAUDE.md`, direnv, git identity
3. ⬜ Accounts, environments, Remote Control services, login, JSON events and prompts
4. ⬜ Collector: OTLP receiver, hooks, samplers, storage, auth check, alerts, `dash`, `top`
5. ⬜ `doctor`, `status`, `uninstall`, final README, CI

## Quick start

On the Mac mini, from a clone of this repository:

```sh
./bootstrap.sh
```

This installs Xcode Command Line Tools, Homebrew and Node, builds and links `devhost`, runs `devhost init` (a few questions) and then `devhost apply --dry-run` followed by `devhost apply`. Pass `--no-apply` to stop after `init`.

Or by hand:

```sh
npm ci && npm run build
devhost init                 # writes ~/.config/devhost/config.yaml
devhost apply --dry-run      # prints the plan, including every sudo command
devhost apply                # idempotent; a second run reports "No changes"
```

## What exists in phase 1

| Command | |
| --- | --- |
| `devhost init [--force] [--hostname h] [--docker colima\|orbstack\|none] [--no-tailscale]` | Wizard → config. Refuses to overwrite without `--force` (a backup is kept). Generates the ntfy topic. |
| `devhost apply [--dry-run] [--only <step>…]` | Runs the steps below. |
| `devhost config get [pointer]` / `set <pointer> <value>` / `validate` / `edit` | Read and change the config, always schema-validated; comments are preserved. Changing config does not apply it. |
| `devhost version` | CLI and contract versions. |

Global flags: `--json`, `--verbose`, `--yes`, `--config <path>`.

Steps run by `apply`, in order:

| Step | Does |
| --- | --- |
| `system.hostname` | `scutil --set` ComputerName / HostName / LocalHostName (sudo) |
| `system.power` | `pmset -a sleep 0 disksleep 0 autorestart 1 womp 1`, per `machine.power` (sudo). A flag set to `false` means "leave alone". |
| `system.ssh` | Remote Login on (sudo). If macOS blocks it (Full Disk Access) you get the exact manual steps and exit code 3. |
| `packages` | Renders `~/.config/devhost/Brewfile` and runs `brew bundle`. `mise` is added automatically when runtimes are configured. |
| `runtimes` | `mise use --global` for each entry of `runtimes`. |
| `shell` | Maintains the `# >>> devhost >>>` block in `~/.zshrc` (Homebrew env, mise). Nothing outside the block is touched. |

`--only system` selects every `system.*` step; `--only system.power` selects one.

Safety rules in effect: timestamped backup (`.devhost-bak-YYYYMMDD-HHMMSS`) before modifying any existing file, every `sudo` announced with its reason and listed in `--dry-run`, no secrets stored (the ntfy topic is the one quasi-secret: anyone who knows it can read your notifications), SIGINT stops after the current step.

## JSON contract

Every command takes `--json`. Short commands print one object, `{ "contractVersion": 1, "ok": true, "data": {…}, "errors": [] }`. `apply` prints NDJSON events (`step`, `log`, `prompt`, `result`), the last line being the `result`. Exit codes: 0 ok · 1 checks failed · 2 usage/config error · 3 human action required · 130 cancelled.

The schemas live in `packages/contract/schemas/*.schema.json`; the TypeScript types are generated from them (`npm run gen`) and committed. CI fails when they drift.

## Repository layout

```
bootstrap.sh
packages/
  contract/   JSON Schemas + generated types + validators (shared with the future app)
  cli/        devhost CLI
    src/{main.ts, commands.ts, apply.ts, config/, steps/, runner/, init/}
    templates/  config.yaml, Brewfile
  app/        Part B (not started)
```

## Development

```sh
npm ci
npm run check      # lint + typecheck + tests
npm run build
npm run gen        # after editing a schema
```

Tests never touch the real system: all process execution goes through one `Runner` interface, and `packages/cli/test/helpers.ts` provides a stateful fake Mac so tests can prove that a second `apply` changes nothing.

## Decisions and open points from phase 1

- **Verified on Linux only.** Everything is tested against a fake runner; nothing has run on a real Mac mini yet. The macOS command details to check on first real run (spec A14): `mise ls --global --json` field names, `mise use --global --yes`, `pmset -g custom` parsing, `systemsetup -setremotelogin on` under the current macOS, the `softwareupdate` path in `bootstrap.sh`.
- **Collector port vs. account ranges.** The spec's own example puts the collector (4318) inside the `business` range (4000–4999). That is allowed; instead an environment's 100-port block may not contain the collector port (so the allocator in phase 3 must skip 4300–4399 there).
- **`packages` is one step** (Brewfile + `brew bundle`), so a dry-run is accurate even when the Brewfile does not exist yet.
- **The `~/.zshrc` block starts in phase 1** because `mise` activation needs it; phase 2 adds direnv and the `claude-<account>` aliases to the same block.
- **Not implemented yet**: Docker, Tailscale, Claude Code, accounts, environments, collector, `doctor`, `status`, `uninstall` (phases 2–5). Unknown commands exit 2.
