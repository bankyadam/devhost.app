# devhost

Turn a fresh Mac mini (Apple Silicon or Intel) into an always-on, headless development server for Claude Code, in one idempotent command, and keep it that way.

You never sit at the Mac mini: work happens through Claude Code Remote Control (Claude app, claude.ai/code), SSH and Tailscale. devhost sets the machine up, runs one Remote Control service per project, and records usage and resource data for every Claude account in one place.

| Part | What | Status |
| --- | --- | --- |
| A | `devhost` CLI + collector (runs on the Mac mini) | **implemented** (phases 1–5), not yet run on a real Mac |
| B | devhost Desktop (macOS app on the MacBook) | **implemented**, not yet built or run on a real Mac |

## Quick start

On the Mac mini, from a clone of this repository:

```sh
./bootstrap.sh
```

That installs Xcode Command Line Tools, Homebrew and Node 24, builds `devhost` and installs it into the Homebrew prefix, runs `devhost init` (three questions), then `devhost apply --dry-run` and `devhost apply`. `--no-apply` stops after `init`.

Node: when nvm is installed (`$NVM_DIR`, default `~/.nvm`), bootstrap runs `nvm install 24` (which also upgrades to the newest 24.x and leaves your nvm default alone); otherwise it installs Homebrew's `node@24`. `DEVHOST_NODE_VERSION=26 ./bootstrap.sh` picks another major. `devhost` is a small wrapper script that runs the CLI with the absolute path of that Node, because ssh and launchd have a minimal PATH that never contains an nvm Node; the collector service uses the same Node. After removing that Node version (for example `nvm uninstall`), run `./bootstrap.sh` again.

Apple Silicon and Intel are both supported. Homebrew lives in `/opt/homebrew` on Apple Silicon and in `/usr/local` on Intel; devhost picks the prefix from the architecture (shell block, Docker CLI plugins, service tool paths). On Intel, Homebrew no longer ships prebuilt bottles, so some formulae build from source (slow, and occasionally failing). Under Rosetta, `bootstrap.sh` stops and `doctor` fails: run them from a native terminal.

Then:

```sh
devhost account add --name personal --default --git-email me@example.com
devhost account add --name business --git-email me@work.example   # prints a URL: open it anywhere, sign in, paste the code
devhost env create --account business --name acme-api --repo git@github.com:acme/api.git
devhost doctor        # everything green?
devhost top           # live view; also works over SSH from a phone
```

The environment now shows up in the Claude app under the `business` account, and comes back by itself after a reboot.

## Concepts

- **Account**: one claude.ai login. At most one is the *default* (uses Claude Code's default config dir, `CLAUDE_CONFIG_DIR` unset); every other account uses `~/.claude-<name>`. Accounts are data in the config, none are built in. Account root: `~/work/<name>/`.
- **Environment**: one project (a git repo under an account root) with its own Remote Control service, a 100-port block (`$DEVHOST_PORT_BASE`…+99), and optional Docker Compose services (project `devhost-<name>`).
- **Routing**: direnv sets `CLAUDE_CONFIG_DIR` for everything below an account root; git identity is switched with `includeIf`; services get the same variables explicitly.

## Commands

| Command | |
| --- | --- |
| `init [--force] [--hostname h] [--docker colima\|orbstack\|none] [--no-tailscale]` | Wizard → `~/.config/devhost/config.yaml`; generates the ntfy topic. |
| `apply [--dry-run] [--only <step>…]` | Idempotent setup. `--dry-run` prints the plan, including every `sudo` command. |
| `doctor` | Read-only checks with one-line fixes (✅/⚠️/❌); exit 1 on any ❌. |
| `status` | One-screen summary. |
| `account list \| add \| remove` | Add: `--name --git-email [--git-name] [--default] [--daily-cost-alert <usd>] [--no-login]`. Remove: refused while the account has environments; `--logout` also signs out; never deletes the root, the config dir or credentials. |
| `login <account>` | Sign in, accept workspace trust and the one-time Remote Control confirmation for each environment, restart its services. |
| `env list \| create \| delete \| start \| stop \| restart \| logs` | Create: `--account --name [--repo] [--no-rc] [--compose auto\|off]`. Delete keeps files unless `--delete-files` (shows unpushed commits, asks for the typed name). |
| `config get \| set \| validate \| edit` | Always schema-validated, comments preserved; changing config does not apply it. |
| `dash [--range 1h\|24h\|7d\|30d] [--account] [--env] [--model] [--follow]`, `top [--once]` | Dashboard data (`--json`) and a refreshing terminal table. |
| `collector run` | The collector in the foreground (launchd runs it for you). |
| `notify --test` | Send a test notification. |
| `uninstall [--keep-packages] [--purge-data] [--dry-run]` | Removes launchd jobs, managed blocks and generated files. |
| `version` | CLI and contract versions. |

Global flags: `--json`, `--verbose`, `--yes`, `--config <path>`.

Also available for the desktop app (same contract): `config raw` (the file with comments), `config put` (replace from stdin, only if valid), `config validate --stdin`, `collector logs`, and `dash` includes the list of models seen.

## What `apply` sets up

| Step | Does |
| --- | --- |
| `system.hostname` / `system.power` / `system.ssh` | `scutil`, `pmset -a sleep 0 disksleep 0 autorestart 1 womp 1`, Remote Login (sudo). A power flag set to `false` means "leave alone". macOS blocking Remote Login (Full Disk Access) → exact manual steps, exit 3. |
| `packages` | Renders `~/.config/devhost/Brewfile`, `brew bundle install --no-upgrade` (brew's output shows while it runs). Only installs what is missing: upgrading stays `brew upgrade`, so an apply does not upgrade or rebuild everything that had a release. Adds what the config implies: direnv, Colima + docker + compose + buildx (or OrbStack), tailscale, `claude-code`. |
| `runtimes` | Installs mise with its own installer (`curl -fsSL https://mise.run \| sh`, a checksummed prebuilt binary in `~/.local/bin/mise`, updated with `mise self-update`) unless a `mise` is already on PATH, then `mise use --global` for each of `runtimes`. Not Homebrew: it has no bottles for Intel Macs any more, and building mise there means building llvm and rust first (hours). |
| `shell` | The `# >>> devhost >>>` block in `~/.zshrc`: Homebrew, mise (from PATH or `~/.local/bin`), direnv hook, `claude-<account>` aliases. |
| `docker.config`, `docker.runtime` | Compose/buildx plugin path; Colima as a boot-time LaunchDaemon with the configured resources. |
| `tailscale` | `sudo brew services start tailscale` (system daemon, no GUI login needed). Logging in is never automated: you get `sudo tailscale up` instructions. |
| `claude.binary` | Records the absolute path of `claude` for plists (the collector runs on the Node that runs devhost). |
| `accounts.claude` | Per account: merges settings into the user-level `settings.json` (keeps your keys), adds OTel + hooks, and a managed block in `CLAUDE.md`. |
| `accounts.routing`, `accounts.git` | Account roots, `<root>/.envrc` + `direnv allow`, `includeIf` per account root. |
| `collector` | LaunchDaemon `com.devhost.collector`. |
| `env.<name>` | Repo (clone or `git init`), `.envrc` (git-excluded), compose, LaunchDaemon `com.devhost.rc.<account>.<name>` (`UserName` = you, `KeepAlive`, `ThrottleInterval 30`). Missing port blocks are allocated and written back to the config. |

`--only system` selects every `system.*` step; `--only env.acme-api` one environment.

**Safety**: a timestamped backup (`.devhost-bak-YYYYMMDD-HHMMSS`) before changing any existing file; every `sudo` is announced with its reason and listed in `--dry-run`; no tokens, keys or passwords are stored; no prompt text, model output, tool input or file content is collected (a test greps the whole database for planted text); `apply` and `env create` are safe to interrupt and re-run (SIGINT stops after the current step). The ntfy topic is the one quasi-secret: anyone who knows it can read your notifications.

## Dashboard, alerts and their limits

The collector is the one long-running process: it receives Claude Code OpenTelemetry (OTLP/HTTP **JSON**) and hook calls on `127.0.0.1:4318`, samples CPU/RAM (system, per environment, best effort per session), Docker, disk, Tailscale and each account's login, and stores everything in SQLite (`~/.local/share/devhost/devhost.db`) with hourly rollups (`retention.rawDays`/`rollupDays`). Remote access is only via SSH (`devhost top`, `devhost dash --json`).

Alerts (ntfy, one notification per state change): memory above the limit for 5 min, low free disk, an account's estimated daily cost above its limit, a Remote Control service restarting more than 3 times in 10 min, a login that stopped being valid (reminder every 24 h).

Known limits (also shown next to the numbers):

- Cost is an estimate from Claude Code; on a subscription it is API-equivalent value, not billed money.
- Subscription plan limits (session/weekly usage) are not in the telemetry and are not shown.
- Per-session CPU/RAM is best effort; per-environment numbers are reliable.
- Cloud sessions and sessions on other machines are out of scope: the Mac mini only.

## JSON contract

Every command takes `--json`. Short commands print `{ "contractVersion": 1, "ok": true, "data": {…}, "errors": [] }`. Long ones (`apply`, `env create`, `login`, `account add`, `uninstall`, `dash --follow`) stream NDJSON events: `step`, `log`, `prompt`, `snapshot`, and a final `result`. A `prompt` event (`open-url`, `input`, `confirm`) is answered by writing `{"id":"…","value":…}` as one line to stdin. Exit codes: 0 ok · 1 checks failed · 2 usage/config error · 3 human action required (e.g. a `sudo` password with no terminal) · 130 cancelled.

Schemas live in `packages/contract/schemas/*.schema.json`; the TypeScript types are generated (`npm run gen`) and committed; CI fails on drift.

## devhost Desktop (Part B)

A macOS app for the MacBook that configures and controls the Mac mini and shows one dashboard across all Claude accounts. It replaces typing `devhost` commands over SSH; it does not replace the Claude app for talking to sessions.

- **No server component.** Every operation is `ssh <host> /usr/bin/env PATH=/opt/homebrew/bin:/usr/local/bin:… devhost <command> --json` (the fixed PATH finds `devhost` on either Mac mini architecture; the wrapper brings its own Node) through the system `ssh`, over Tailscale, using your `~/.ssh/config`, agent and keys (`BatchMode`, one multiplexed connection per host via `ControlMaster`/`ControlPersist`). Long commands stream NDJSON; prompt answers (login code, workspace trust, typed confirmations) are written to the command's stdin, never onto a command line. The app stores only the host name and UI preferences (no credentials, no keys, no telemetry copies).
- **Screens.** Dashboard (health, per-account totals with the cost-alert meter, usage chart by account or token type with a table view, environments panel, live sessions table with waiting-for-input highlighted, filters, session actions); Environments (▶ opens the environment's Remote Control environment on claude.ai/code, where new sessions start, in the account's web app; start/stop/restart, logs and delete with typed confirmation under "…"; create wizard); Accounts (new-account wizard that continues into the login, re-login with the browser step, Safari web app setup, remove); Configuration (form generated from the config schema plus a YAML tab, live validation by the CLI on the Mac mini, invalid configs cannot be saved, then dry-run diff → confirm → live apply; steps needing `sudo` open a Terminal window so the app never sees the password); Doctor and logs; menu bar item (status dot, sessions waiting, quick links).
- **Compatibility.** On connect it runs `devhost version --json` and refuses a different contract major with a clear message. An unreachable Mac mini is shown as such, the last data stays visible, and the app reconnects by itself.
- **Safety.** The webview can only ask the Rust shell for `devhost <known subcommand> ...` on the configured host, three fixed Terminal actions (`devhost …`, a shell in a project directory, `claude --resume <id>`), `code --remote`, http(s) URLs and the account web apps (only valid account names reach a file path; only a PNG of at most 4 MB is written as an icon). Quoting and validation live in `packages/app/core` with unit tests (hostile hosts, directories, arguments).
- **Several accounts side by side.** The Claude app is signed in to one account at a time, and its signed builds ignore a second data directory, so it cannot run once per account. A Safari web app keeps its own cookies instead: Accounts → *Set up…* draws an icon in the account's color (the devhost tile with the account name), saves it under `~/Library/Application Support/app.devhost.desktop/web-app-icons/`, opens claude.ai/code in Safari and shows the icon in Finder. Safari has no API for *Add to Dock*, so that step is yours: File → Add to Dock…, name `Claude – <account>` (exactly), drag the icon onto the dialog's icon, sign in. *Done, check* looks for `~/Applications/Claude – <account>.app`; a web app made earlier under another name can be picked instead (*Already have one?*, remembered per account). From then on every "open Claude" for that account opens its web app, and without one the default browser: ▶ in Environments opens the environment's Remote Control link (`https://claude.ai/code?environment=env_…`, which `devhost env list --json` reads from the service log as `remoteControl.url`), the session menu likewise. A Remote Control service started with `--spawn worktree` has no session until you start one there.
- **Session actions.** *Open in claude.ai/code* opens the session list (the page lists Remote Control sessions by name, `<account>-<env>`); *Terminal: resume* runs `claude --resume <id>` in the environment directory with the account's direnv environment; *VS Code* appears only if the `code` CLI is found; *Dev server* opens `http://<host>:<port base>`.

Requirements: a Mac on macOS 26 or later (the bundle's minimum), Node 24, Rust (stable), `ssh` access to the Mac mini. The app is a **universal binary** (Apple Silicon and Intel, `universal-apple-darwin`); the Mac mini server side supports both too. No signing or notarization (personal local builds).

```sh
npm ci && npm run build:core
npm run dev -w @devhost/app            # UI in a browser against a built-in demo host (no ssh)
npm run tauri -w @devhost/app dev      # the real app
npm run tauri:build -w @devhost/app    # universal → packages/app/src-tauri/target/universal-apple-darwin/release/bundle/macos/devhost.app
npm run tauri:build:arm -w @devhost/app # Apple Silicon only (faster)
```

What was verified without a Mac: 67 UI tests that drive the screens against the **real CLI** (in-process, on the fake Mac) including both wizards, login and trust prompts, delete confirmations, the config → dry-run → apply flow, the sudo → Terminal path, reconnect after an outage and the version refusal; 15 Rust tests for the shell logic; and the Tauri crate type-checks for both `aarch64-apple-darwin` and `x86_64-apple-darwin` (`cargo check`, with a stub C compiler for one Objective-C helper because the check ran on Linux). **Not verified**: building and running the bundled app on macOS 26 (including the universal lipo step, which only runs on macOS), the real `ssh` round trip, the tray item, the Terminal/VS Code launchers, and the web app setup in the bundled app (WKWebView drawing the icon, Safari and Finder opening, the `~/Applications` check).

## Development

```sh
npm ci
npm run check      # lint + typecheck + tests (TypeScript and Rust)
npm run build
npm run gen        # after editing a schema
```

All process execution goes through one `Runner` interface; `packages/cli/test/helpers.ts` has a stateful fake Mac, so tests prove things like "a second `apply` changes nothing" without touching a real system. Test hooks: `DEVHOST_LAUNCHD_DIR` (where plists are installed), `DEVHOST_TRUST_IDLE_MS`.

```
bootstrap.sh
packages/
  contract/   JSON Schemas + generated types + validators
  cli/        devhost CLI and collector
    src/{main.ts, commands*.ts, apply.ts, config/, steps/, runner/, collector/, doctor/, init/}
    templates/  config.yaml, Brewfile, launchd.plist, CLAUDE.md
  app/        devhost Desktop (Part B): Tauri v2 + React
    src/        transport/ (Tauri + demo), client/ (typed devhost --json calls), screens/, ui/, lib/
    core/       devhost-core: ssh command building, quoting, validation (pure Rust, tested everywhere)
    src-tauri/  the Tauri shell around the system ssh
    test/       tests that run the real CLI behind the app
```

## Verified against the docs (spec A14)

Checked on code.claude.com while building:

- Homebrew cask `claude-code` (stable channel); native installer `curl -fsSL https://claude.ai/install.sh | bash`; Homebrew installs do not auto-update.
- `claude auth status` exits 0 when logged in, 1 when not; the credential store and Keychain entry are keyed by `CLAUDE_CONFIG_DIR`, so the default account must be checked with the variable **unset**.
- `claude remote-control` flags `--name`, `--spawn same-dir|worktree`, `--permission-mode`, `--[no-]create-session-in-dir`; it asks `Trust <dir>? [y/N]` and `Enable Remote Control? (y/n)` once; server mode exits after ~10 min without network.
- **HTTP hooks are not supported for `SessionStart`** (only command hooks), so that event posts the payload with `curl`; the other four events use HTTP hooks. `allowedHttpHookUrls` is written as a glob (`http://127.0.0.1:4318/hooks*`).
- OTel variables, metric names (`claude_code.token.usage` with `type` input/output/cacheRead/cacheCreation, `cost.usage`, `session.count`, …), the `api_request` event, default **delta** temporality, and that exporter variables are ignored in project settings.

Still to verify on a real Mac (not testable on Linux): `mise ls --global --json` field names, `pmset -g custom` and `systemsetup -setremotelogin` on the current macOS, `sudo brew services` for Tailscale at boot, Colima's `start --foreground` under launchd, the `softwareupdate` path in `bootstrap.sh`, whether trusting a parent directory covers new subdirectories (devhost records trust per environment directory and checks ancestors), and the pty (`script`) trick used to answer the trust questions without a terminal.

## Decisions and deviations from the spec

- **`.envrc` uses `source_up_if_exists`** instead of `source_up`: for the default account there is no parent `.envrc`, and `source_up` would print an error.
- **Collector port vs. account ranges**: the spec's own example puts 4318 inside the `business` range (4000–4999). That is allowed; an environment's block may just not contain the collector port, so allocation skips 4300–4399 there.
- **Dry-run is exact**: steps run their `apply()` against a recording executor; read-only checks still execute.
- **Services are system LaunchDaemons**, so `env start|stop|restart` need `sudo` (a password prompt in a terminal; exit 3 without one). `env stop` lasts until `env start` or the next reboot.
- **Uninstall leaves** Tailscale, SSH, hostname/power settings, the Colima VM, mise runtimes, `config.yaml`, and (without `--purge-data`) the database, so the machine stays reachable. Packages are only removed after a confirmation, and Homebrew refuses ones others depend on.
- `node:sqlite` (Node 24) is used so there is no native dependency; its experimental warning is silenced.
- `account add --force-default-switch` is rejected with an explanation (out of scope for v1, as in the spec).

## Troubleshooting

- **`packages` fails with "Installing <pkg> has failed!"** → run `brew install <pkg>` to see brew's own error. On an Intel Mac Homebrew no longer ships bottles (Tier 3), so formulae build from source; if that stops at "Cannot find a C++ compiler that supports both C++11" and `clang++` cannot find `<string>`, a stale `/Library/Developer/CommandLineTools/usr/include/c++` (a few leftover files) hides the SDK's libc++ headers: `sudo mv /Library/Developer/CommandLineTools/usr/include/c++ /Library/Developer/CommandLineTools/usr/include/c++.bak`, then `devhost apply` again.
- **Service exits with "Workspace not trusted"** → `devhost login <account>` (accepts trust, restarts services).
- **Remote Control service says not logged in, but `claude auth status` works for you** → the services run in the system domain without a GUI session and may not reach the login Keychain. Log in over SSH (the Keychain write fails there and Claude Code falls back to `~/.claude*/.credentials.json`), then `devhost doctor` shows the credential store.
- **After a reboot nothing starts** → FileVault is on and waiting for the disk to be unlocked; `doctor` reports it.
- **No data in the dashboard** → `devhost doctor` (`collector.*` checks); Claude Code must be started after `apply` wrote the OTel settings.
- **Re-login**: `devhost login <account>` (the collector notifies you when a login stops being valid).
