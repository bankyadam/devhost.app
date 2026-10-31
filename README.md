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
| `doctor` | Read-only checks with one-line fixes (✅/⚠️/❌); exit 1 on any ❌. Plugins add theirs as `plugin.<name>.<check>`. |
| `plugin list`, `plugin widgets`, `plugin run <plugin> <action> [--env n] [--session id] [--dry-run] [--yes]`, `plugin install <source> [--name] [--enable]`, `plugin uninstall <name>`, `plugin enable\|disable <name>` | devhost plugins (see Plugins below). An action that removes or stops something asks first. |
| `status` | One-screen summary. |
| `account list \| add \| remove` | Add: `--name --git-email [--git-name] [--default] [--daily-cost-alert <usd>] [--no-login]`. Remove: refused while the account has environments; `--logout` also signs out; never deletes the root, the config dir or credentials. |
| `login <account>` | Sign in, accept workspace trust and the one-time Remote Control confirmation for each environment, restart its services. The first sign-in records the account's claude.ai login (`accounts[].claudeLogin`); a sign-in as anyone else, or as another account's login, is signed out again and refused (the environments would register under the wrong claude.ai account). `--switch-login` accepts a new login on purpose and forgets the account's Remote Control state (bridge pointers, device id), so its environments register afresh under it. The services (LaunchDaemons) sign in with `<config dir>/.credentials.json`; a sign-in from a terminal on the Mac stores the new login in the Keychain and leaves that file as it was, so `login` checks whose login the file holds (claude.ai's profile endpoint), copies the Keychain sign-in into it when they differ (or refuses), and then starts Remote Control afresh. `doctor` shows who each account's services are signed in as. |
| `env list \| create \| delete \| start \| stop \| restart \| sleep \| wake \| logs` | Create: `--account --name [--repo] [--no-rc] [--compose auto\|off]`. Delete keeps files unless `--delete-files` (shows unpushed commits, asks for the typed name).  Running `env create` again for an environment that is in the config continues (or repeats) its setup with the config's settings, e.g. after a failed `docker compose up`; the app has *Try again* and Environments → … → *Run setup again*. A compose network left from before is reported with how to remove it (devhost never removes it). `sleep` stops the compose services running now (they stay noted), `wake` starts exactly those again; the collector does both on its own: asleep after `docker.idleSleepMinutes` (default 60) without a session, awake with the next one. A service stopped by hand stays stopped. |
| `config get \| set \| validate \| edit` | Always schema-validated, comments preserved; changing config does not apply it. |
| `dash [--range 1h\|24h\|7d\|30d] [--account] [--env] [--model] [--follow]`, `top [--once]` | Dashboard data (`--json`) and a refreshing terminal table. |
| `agents list` | The subagent catalog (built-in: `explorer`, `reviewer`, `test-runner`, `docs`, plus `agents.custom`) and the agents each account and environment has. Choose them with `agents: [name, …]` on an account or environment (`config set` or the app's Agents screen), then `apply --only agents`: the agent files go to `<Claude config dir>/agents/` and `<environment>/.claude/agents/`; only files devhost marked are ever changed. `agents.delegation: true` adds a short subagent rule to each account's CLAUDE.md. |
| `session reattach <id> [--dry-run]` | Bring an ended Remote Control session back, e.g. after a reboot (the environment's service then registers anew and the old session is left without a machine). Only for sessions a service started in its own worktree (`.claude/worktrees/bridge-cse_<id>` ↔ `session_<id>` on claude.ai): runs `claude remote-control --session-id session_<id>` there as a one-shot LaunchDaemon (`com.devhost.reattach.cse_<id>`, not restarted when the session ends; earlier ended ones are removed on the next reattach and by `uninstall`). Usually not needed: writing in the session on claude.ai continues it under the environment's service, and a service renews its bridge pointer before it starts, so after a long stop (Claude Code drops a pointer older than 4 hours) it comes back with its own environment and session. Sessions in the environment's folder cannot be reattached: the folder is the service's. While a reattach job runs, claude.ai lists a single-session environment named `bridge-cse_…` instead of the environment. |
| `update [--check] [--all] [--force] [--dry-run]` | Update Claude Code: `brew upgrade --cask claude-code`, then restart every Remote Control service onto it (a service runs its sessions from the versioned Caskroom path the upgrade deletes) and list the sessions they had open (each continues under its environment as soon as you write in it on claude.ai; running reattach jobs are removed, since they hide the environment on claude.ai). Waits while a session is in the middle of a turn unless `--force`; refuses to run from inside a session of a service it would restart. `--check` only reports; `--all` also upgrades the outdated Brewfile packages. The collector does it on its own (`claude.update: auto`, the default) inside `claude.updateWindow` (default `02:00-06:00`), and notifies; `notify` only tells you, `off` neither. The app: Dashboard → host card → Claude Code → *Update now…*. |
| `storage list \| status \| wait \| adopt <volume> \| set-passphrase \| migrate --account <a> [--cleanup] \| prepare <disk> --label <name> --yes-erase` | The external work volume (see Work volume below). `prepare` erases a disk: CLI only, never from the app. |
| `collector run` | The collector in the foreground (launchd runs it for you). |
| `notify --test` | Send a test notification. |
| `uninstall [--keep-packages] [--purge-data] [--dry-run]` | Removes launchd jobs, managed blocks and generated files. |
| `version` | CLI and contract versions. |

Global flags: `--json`, `--verbose`, `--yes`, `--config <path>`.

Also available for the desktop app (same contract): `config raw` (the file with comments), `config put` (replace from stdin, only if valid), `config validate --stdin`, `collector logs`, and `dash` includes the list of models seen.

## What `apply` sets up

| Step | Does |
| --- | --- |
| `system.helper` | With `machine.rootHelper: true`: installs the root helper `/Library/PrivilegedHelperTools/app.devhost.root` (root:wheel 0755) and `/etc/sudoers.d/devhost` (checked with `visudo -c` first), which lets you run it, and only it, without a password. From then on devhost's root operations (installing, starting, stopping and removing its own LaunchDaemons, hostname, power, Remote Login) go through it: no sudo password, so the desktop app and ssh need nobody at the Mac mini's keyboard. Installing or updating the helper asks for the password once. `false` removes both. |
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
| `env.<name>` | Repo (clone or `git init`), `.envrc` (git-excluded), compose, LaunchDaemon `com.devhost.rc.<account>.<name>` (`UserName` = you, `KeepAlive`, `ThrottleInterval 30`). Each start writes `[devhost] started <time>` to its log and waits (up to 3 minutes) until `api.anthropic.com` resolves: at boot launchd starts it before the network is up. The collector rotates the service logs in `~/Library/Logs/devhost` once a day (`<log>.1.gz` … compressed, emptied in place) and keeps `collector.retention.logDays` (default 7) days; a log nothing wrote to for that long is removed. `doctor` reads the log from the last start: a sign-in error there (expired token, 401) fails with `devhost login <account>`. Missing port blocks are allocated and written back to the config. |

`--only system` selects every `system.*` step; `--only env.acme-api` one environment.

**Safety**: a timestamped backup (`.devhost-bak-YYYYMMDD-HHMMSS`) before changing any existing file; every `sudo` is announced with its reason and listed in `--dry-run`; no tokens, keys or passwords are stored; no prompt text, model output, tool input or file content is collected (a test greps the whole database for planted text); `apply` and `env create` are safe to interrupt and re-run (SIGINT stops after the current step). The ntfy topic is the one quasi-secret: anyone who knows it can read your notifications.

## Dashboard, alerts and their limits

The collector is the one long-running process: it receives Claude Code OpenTelemetry (OTLP/HTTP **JSON**) and hook calls on `127.0.0.1:4318`, samples CPU/RAM (system, per environment, best effort per session), Docker, disk, Tailscale and each account's login, and stores everything in SQLite (`~/.local/share/devhost/devhost.db`) with hourly rollups (`retention.rawDays`/`rollupDays`). Usage and sessions belong to the account whose login sent them: the collector records each account's organization id and email from `claude auth status`, and a session whose telemetry carries a known one is that account's, even when the process read another account's config directory (the Claude app's own Claude Code always reads `~/.claude`). Otherwise the account comes from the environment directory, then from the config directory's hook URL. Subagents come from the `SubagentStart`/`SubagentStop` hooks (their id and type only, never prompt or answer); every sample also counts the agents at work (sessions running a turn plus running subagents) per account and in total, rolled up hourly as peak and average. **Where the time goes:** from Claude Code's `api_request` and `tool_result` events (tool name and duration only), per session merged so parallel work counts once: the model's share, the time spent only on this host's tools (Bash, Read, Edit…), its CPU-bound part (from the session's CPU samples), network tools, the time per tool, and what a 2× or 4× faster CPU would save; plus memory: the largest session, system peak, swap and time under memory pressure (dashboard cards "Where the time goes" and "Memory", `dash --json` → `profile`). It starts with the first tool run recorded. Remote access is only via SSH (`devhost top`, `devhost dash --json`).

**Keeping the collector light** (spec A10.9): one `ps` per 5 s tick, attributed by process tree (never `lsof`); every external source single-flight with a timeout, a still-running source skips its tick; Tailscale every 60 s straight from tailscaled's LocalAPI on its unix socket (macOS's `tailscale` CLI runs `lsof` on every call; with the GUI Tailscale app `doctor` recommends the open source tailscaled); the dashboard snapshot precomputed each tick, so `dash --follow` and the plugins only read it. The collector records its own CPU, memory and child processes; `doctor` fails above 3 % CPU over 5 minutes or on overlapping commands. `npm run soak` checks all of this for 10 minutes against a copy of this host's data.

Alerts (ntfy, one notification per state change): memory above the limit for 5 min, low free disk, an account's estimated daily cost above its limit, a Remote Control service restarting more than 3 times in 10 min, a login that stopped being valid (reminder every 24 h).

Known limits (also shown next to the numbers):

- Cost is an estimate from Claude Code; on a subscription it is API-equivalent value, not billed money.
- Subscription plan limits (session/weekly usage) are not in the telemetry and are not shown.
- Per-session CPU/RAM only for Remote Control sessions; per-environment numbers are reliable.
- Cloud sessions and sessions on other machines are out of scope: the Mac mini only.

## JSON contract

Every command takes `--json`. Short commands print `{ "contractVersion": 1, "ok": true, "data": {…}, "errors": [] }`. Long ones (`apply`, `env create`, `login`, `account add`, `uninstall`, `dash --follow`) stream NDJSON events: `step`, `log`, `prompt`, `snapshot`, and a final `result`. A `prompt` event (`open-url`, `input`, `confirm`) is answered by writing `{"id":"…","value":…}` as one line to stdin. Exit codes: 0 ok · 1 checks failed · 2 usage/config error · 3 human action required (e.g. a `sudo` password with no terminal) · 130 cancelled.

Schemas live in `packages/contract/schemas/*.schema.json`; the TypeScript types are generated (`npm run gen`) and committed; CI fails on drift.

## Plugins

A devhost plugin is an ES module whose default export lists actions and checks (`packages/cli/src/plugins/api.ts`; `definePlugin` gives the types). It runs in the CLI on the Mac mini, as you, and changes things only through `ctx.exec`, so `--dry-run`, the plan and the root helper work as for `apply`. An action is scoped to the host, an environment or a session; the desktop app shows host actions on its Plugins screen, environment actions in the environment's "…" menu and session actions in the session's Open menu. Checks appear in `devhost doctor`.

- **Advice** (`advice: [{ check, on?, run(ctx, check) }]`): a note under another check, devhost's or another plugin's, in `devhost doctor` and the app's Doctor screen. `check` is a check id, `*` standing for one dot-separated part (`env.*.service`); `on` the statuses it is asked for (default warn and fail). `run` returns `{ message, fix?, action? }` or `null`; `action` (one of the plugin's host actions) becomes the fix `devhost plugin run <plugin> <action>` and a button in the app. Example: disk-cleanup under `system.disk`.
- **Widgets** (`widgets: [{ id, title, size?, refreshSeconds?, run(ctx, params) }]`): cards on the app's dashboard, below the host's health; `size: 'wide'` spans the page. `run` returns one card or several (`[{ key, title, … }]`, e.g. one per account), each `{ status?, summary?, account?, tiles?: [{ label, value, sub? }], rows?: [{ label, value, note? }], meter?: { label, value, max }, chart?: { title, series, colorBy?, points: [{ ts, values }], axis, format, height? }, note?, action? }`: text values are the plugin's to format, a chart takes numbers (stacked columns over time; `colorBy: 'account'` gives series the accounts' colors), `account` colors the card, `action` is a button. **Filters** (`filters: [{ id, label, kind: 'segmented' | 'select', default?, allLabel?, options(ctx) }]`) appear above the plugin's cards; their values reach `run` as `params` and the app remembers them. `ctx.stats({ range, account?, env?, model? })` is the collector's dashboard data. `devhost plugin widgets [--param <plugin>.<filter>=<value>]…` prints them; the app loads them on connect, when a filter changes, every `refreshSeconds` (default 300) and after a card's action ran.

- **Plugins of bankyadam's** (private repositories; install with the SSH URL):
  - [`devhost-plugin-disk-cleanup`](https://github.com/bankyadam/devhost-plugin-disk-cleanup): frees disk space (Homebrew and npm caches, old Remote Control worktrees that are clean and pushed); `report`, `clean`, and a doctor check. `devhost plugin install git@github.com:bankyadam/devhost-plugin-disk-cleanup.git --enable`
  - [`devhost-plugin-session-stop`](https://github.com/bankyadam/devhost-plugin-session-stop): stops a Remote Control session's local `claude` process to free memory (only a devhost service's child in the session's directory). `devhost plugin install git@github.com:bankyadam/devhost-plugin-session-stop.git --enable`
- **Built in**: `stats`, the dashboard's usage statistics: filters (time range, account, environment, model, tokens or cost, stacked by account or token type), a card per account (today, this week, the daily cost alert), usage over time and agents at work. It reads the collector through `ctx.stats` like any plugin could. Built-in plugins (`src/plugins/builtin`) are on unless `plugins.<name>.enabled: false` and cannot be uninstalled. The dashboard itself keeps the host's health, the environments and the sessions.
- **Your own**: `~/.config/devhost/plugins/<name>/index.js`, loaded only with `plugins.<name>.enabled: true`; `plugins.<name>.options` is `ctx.options`. A plugin uses only the plugin API (`ctx.exec`, `ctx.sessions()`, `ctx.services()`, …) and Node's own modules, never devhost's other modules, so it can live in its own repository.
- **From GitHub**: `devhost plugin install <https://github.com/owner/repo | owner/repo | git@github.com:owner/repo.git>[#branch-or-tag] [--name n] [--enable]` clones it (shallow) into `~/.config/devhost/plugins/<name>` (name: the repository's without `devhost-plugin-`), installs its npm dependencies with `--ignore-scripts`, and records the source and commit (`plugin list` shows them). Nothing of it runs until it is enabled. `plugin uninstall <name>` removes it and its config entry; `plugin enable|disable <name>`. Built-in plugins can only be disabled. The app's Plugins screen does the same (Install from GitHub…, Enable/Disable, Uninstall…). For a private repository use its `git@github.com:` URL (your SSH key).

```yaml
plugins:
  disk-cleanup: { enabled: true, options: { warnGiB: 10 } }
  my-tool: { enabled: true, options: { who: me } }
```

## Work volume (external SSD)

Optional: project data (account roots, environments, worktrees, `node_modules`) on one external APFS volume, the system, Claude config, credentials, the collector database and logs on the internal disk.

```sh
devhost storage list                      # external disks and their APFS volumes
devhost storage adopt disk5s1             # or its UUID / mount point: config + /Volumes/<name>/.devhost-volume
printf %s "$PASS" | devhost storage set-passphrase   # encrypted volume: into the System keychain (stdin only)
devhost apply                             # mount at boot, unlock service, ownership, Spotlight off
devhost storage migrate --account personal          # move an existing account (old copy kept until --cleanup)
```

- The volume is the configured one only when it is mounted at `/Volumes/<label>`, diskutil reports its APFS UUID and the marker file names it. devhost never creates anything under a `/Volumes/<label>` that is not mounted.
- New accounts get `<root>/<name>` on the volume (`account add --root` overrides). Paths are real paths everywhere (no symlinks).
- Services of environments on the volume, and Colima, start through `devhost storage wait`; Colima mounts the volume's root (virtiofs). Environments on the internal disk keep their services untouched: adopting a volume or applying again restarts none of them.
- An encrypted volume unlocks at boot without a login: a root service (`com.devhost.storage.unlock`) pipes the passphrase from the System keychain into `diskutil apfs unlockVolume -stdinpassphrase`.
- `prepare <disk>` erases an external disk as APFS (`--encrypted`: passphrase from stdin) and is the only destructive path, with `migrate --cleanup`. `uninstall --purge-storage` removes the unlock service and the keychain item, never the volume.
- **Not yet verified on real hardware** (this host has no external SSD): mounting at boot without a login on macOS 26, the pre-login unlock from the System keychain, and the keychain write itself (the Keychain was locked in the session that built it).

## devhost Desktop (Part B)

A macOS app for the MacBook that configures and controls the Mac mini and shows one dashboard across all Claude accounts. It replaces typing `devhost` commands over SSH; it does not replace the Claude app for talking to sessions.

- **No server component.** Every operation is `ssh <host> /usr/bin/env PATH=/opt/homebrew/bin:/usr/local/bin:… devhost <command> --json` (the fixed PATH finds `devhost` on either Mac mini architecture; the wrapper brings its own Node) through the system `ssh`, over Tailscale, using your `~/.ssh/config`, agent and keys (`BatchMode`, one multiplexed connection per host via `ControlMaster`/`ControlPersist`). Long commands stream NDJSON; prompt answers (login code, workspace trust, typed confirmations) are written to the command's stdin, never onto a command line. The app stores only the host name and UI preferences (no credentials, no keys, no telemetry copies).
- **Screens.** Dashboard (health, per-account totals with the cost-alert meter, usage chart by account or token type with a table view, Agents at work (how many agents worked at once: sessions running a turn plus their subagents, now, the peak in the range and per bucket), filters); Sessions (the idle and active ones, with waiting-for-input highlighted, each session's subagents (running, total, types) and title (read from its transcript when the dashboard is built, never stored; Remote Control sessions keep their title on claude.ai, so their last prompt is shown instead, in italics), session actions); Environments (CPU, RAM, containers, disk and open sessions per environment; ▶ opens the environment's Remote Control environment on claude.ai/code, where new sessions start, in the account's web app; start/stop/restart, logs and delete with typed confirmation under "…"; create wizard); Accounts (new-account wizard that continues into the login, re-login with the browser step, Safari web app setup, remove); Plugins (the host's plugins and their host actions, with a preview for the ones that remove things); Configuration (form generated from the config schema plus a YAML tab, live validation by the CLI on the Mac mini, invalid configs cannot be saved, then dry-run diff → confirm → live apply; steps needing `sudo` open a Terminal window so the app never sees the password, unless the root helper does them); Doctor; Logs (collector and Remote Control logs grouped by account, followed live) (every running command, setups included, shows an endless spinner at the running step and how long it has been going, so a slow step is not mistaken for a hung one); menu bar item (a monochrome `>_` like the other menu bar icons; yellow or red only in its cursor for "something to look at" or an alert, plus the number of sessions waiting, and quick links).
- **Compatibility.** On connect it runs `devhost version --json` and refuses a different contract major with a clear message. An unreachable Mac mini is shown as such, the last data stays visible, and the app reconnects by itself.
- **Safety.** The webview can only ask the Rust shell for `devhost <known subcommand> ...` on the configured host, three fixed Terminal actions (`devhost …`, a shell in a project directory, `claude --resume <id>`), `code --remote`, http(s) URLs and the account web apps (only valid account names reach a file path; only a PNG of at most 4 MB is written as an icon). Quoting and validation live in `packages/app/core` with unit tests (hostile hosts, directories, arguments).
- **Several accounts side by side.** The Claude app is signed in to one account at a time, and its signed builds ignore a second data directory, so it cannot run once per account. A Safari web app keeps its own cookies instead: Accounts → *Set up…* draws an icon in the account's color (the devhost tile with the account name), saves it under `~/Library/Application Support/app.devhost.desktop/web-app-icons/`, opens claude.ai/code in Safari and shows the icon in Finder. Safari has no API for *Add to Dock*, so that step is yours: File → Add to Dock…, name `Claude – <account>` (exactly), drag the icon onto the dialog's icon, sign in. *Done, check* looks for `~/Applications/Claude – <account>.app`; a web app made earlier under another name can be picked instead (*Already have one?*, remembered per account). From then on every "open Claude" for that account opens its web app, and without one the default browser: ▶ in Environments opens the environment's Remote Control link (`https://claude.ai/code?environment=env_…`, which `devhost env list --json` reads from the service log as `remoteControl.url`), the session menu likewise. A Remote Control service started with `--spawn worktree` has no session until you start one there.
- **Root helper** (`machine.rootHelper`). A JavaScript for Automation script run by the system's `/usr/bin/osascript`, so no Node, Homebrew or other user-writable file takes part in it. It does only fixed operations and checks each: service labels are `com.devhost.*`; a plist it installs or loads may only have `Label`, `UserName` (must be you), `ProgramArguments`, `EnvironmentVariables`, `WorkingDirectory` (inside your home), `RunAtLoad`, `KeepAlive` and `ThrottleInterval`, and it installs the bytes it checked; hostnames and power settings are validated. So the passwordless rule never gives more than your account already has: every service runs as you. Services log through `/bin/sh` as you (`exec >>"$0" 2>&1 && exec "$@"`) instead of `StandardOutPath`, which launchd opens as root (a symlink in your log directory could otherwise point it at any file). Not through the helper, still asking for the password: installing the helper itself, and Tailscale's `brew services` (its daemon runs as root from a user-writable Homebrew prefix).
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
- **The account's web app shows only archived sessions** (Team/Enterprise) → the org requires trusted devices, and each Safari web app has its own storage, so claude.ai sees it as a new device: verify it with a passkey in that web app too (open a session or sign in again there to get the prompt), even if Safari already has one. A Remote Control service started with `--spawn worktree` has no session until you start one with *New* in its environment.
- **Service exits with "Workspace not trusted"** → `devhost login <account>` (accepts trust, restarts services). Claude Code has no flag for it, and its trust dialog ignores an answer that "arrived too quickly after the question to count", so devhost answers on a pseudo-terminal (`templates/pty-run.py`, run by the system's `/usr/bin/python3`) and waits at least 1.5 s after the question, whether a person or `--yes` said yes. It then checks that Claude Code really recorded the trust (`hasTrustDialogAccepted` in `~/.claude.json`, or the account's config directory) and says so when it did not: `trust.<env>` is only ✅ then. With `--yes` (or `devhost login <account> --yes`) it needs nobody at the keyboard.
- **Remote Control service says not logged in, but `claude auth status` works for you** → the services run in the system domain without a GUI session and may not reach the login Keychain. Log in over SSH (the Keychain write fails there and Claude Code falls back to `~/.claude*/.credentials.json`), then `devhost doctor` shows the credential store.
- **After a reboot nothing starts** → FileVault is on and waiting for the disk to be unlocked; `doctor` reports it.
- **No data in the dashboard** → `devhost doctor` (`collector.*` checks); Claude Code must be started after `apply` wrote the OTel settings.
- **Re-login**: `devhost login <account>` (the collector notifies you when a login stops being valid).
