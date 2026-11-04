# devhost — Product Specification

> Working name. Rename freely; it is used below as the binary, config, and app name.

The product has two parts, delivered in order:

- **Part A — `devhost` CLI + collector (v1):** runs on the Mac mini. Sets up and maintains the server, manages environments, collects usage and resource data.
- **Part B — devhost Desktop (v2):** a macOS app on the MacBook. Configures and controls the Mac mini, creates environments, and shows one dashboard across all Claude accounts.

Part A must be built so that Part B needs **no extra server component**: every capability the app uses is a `devhost` command with machine-readable output, called over SSH.

---

# Part A — `devhost` CLI and collector

## A1. Purpose

Turn a fresh Mac mini (Apple Silicon or Intel) into an always-on, headless development server for Claude Code, in one idempotent command, and keep it that way. The owner never sits at the Mac mini: work happens through Claude Code Remote Control (Claude app / claude.ai/code), SSH, and Tailscale.

## A2. Users and context

- **One operator**, one macOS user account on the Mac mini.
- **N Claude accounts** (claude.ai subscriptions), none built in. `init` creates no accounts; they are added with `devhost account add` (A7.11) or from the app. Typical setup: `personal` and `business`, possibly more.
  - At most **one** account is the *default*: it uses Claude Code's default config dir (`CLAUDE_CONFIG_DIR` **unset**).
  - Every other account gets `CLAUDE_CONFIG_DIR=~/.claude-<name>`.
  - Each account signs in with **its own** claude.ai login; devhost records it and refuses another (A7.10).
- **Account roots:** `~/work/<name>/` per account by default; `<storage.workVolume.root>/<name>` when an external work volume is configured (A7.12).
- **Environment** = one project: a git repository under an account root, with its own Remote Control service, port block, and optional Docker Compose services. Example: `~/work/business/acme-api`.
- **Project stack:** Node.js/TypeScript, PHP, Ruby, Python, PostgreSQL, MongoDB (via Docker).
- **Hardware target:** Mac mini M4 Pro, 64 GB RAM, 2 TB SSD. Must work on any Apple Silicon or Intel Mac on the current macOS. A Mac mini with a smaller internal disk (512 GB) can keep project data on one external SSD (A7.12).

## A3. Goals

1. **One-command setup** on a fresh macOS install, starting from the built-in shell only.
2. **Idempotent:** a second `apply` changes nothing and says so.
3. **Declarative:** all choices live in one config file the owner can version in git.
4. **Headless-safe:** survives reboot, SSH disconnects, network drops; runs without a GUI login.
5. **Observable:** `doctor` explains every problem with a fix; the collector records sessions, tokens, CPU, and memory for every account in one place.
6. **Machine-readable:** every command supports `--json` (contract in A9) so Part B can drive it over SSH.
7. **Safe:** never silently overwrites user files, never stores secrets, explains every `sudo`, never collects prompt or code content.
8. **Extensible:** plugins (A18) add actions, doctor checks and advice, and dashboard widgets without changing devhost.

## A4. Non-goals (v1)

- Local LLM inference.
- A second macOS user / OS-level isolation.
- Backups, external monitoring stacks (Prometheus, Grafana), or multi-server management.
- Linux servers and clients. (Intel Macs are supported since phase 6; Rosetta is refused: run natively.)
- More than one external work volume.

## A5. Technical approach

- **Language:** TypeScript on Node.js 24. Monorepo (see A15) so Part B shares types with the CLI.
- **Bootstrap:** `bootstrap.sh` (shellcheck-clean) installs Xcode CLT, Homebrew, and Node 24 (through nvm when present, `nvm install 24`; else Homebrew `node@24`), builds the CLI and installs `devhost` into the Homebrew prefix as a small wrapper script that runs the CLI with that Node's absolute path (ssh and launchd have a minimal `PATH` without nvm). Then `devhost init` (if no config) and `devhost apply`. Stops under Rosetta.
- **Homebrew prefix by architecture:** `/opt/homebrew` (Apple Silicon), `/usr/local` (Intel). Every generated path uses the detected prefix.
- **Packages:** generated `Brewfile`, applied with `brew bundle install --no-upgrade` (installs what is missing; upgrading stays `brew upgrade`). Do not reimplement package management. mise is installed with its own checksummed installer, not Homebrew (no Intel bottles).
- **Templates:** every generated file (settings.json, CLAUDE.md, launchd plists, .envrc, gitconfig fragments) is rendered from `templates/`.
- **Supervision:** launchd only. The collector (A10) is the one long-running process devhost adds; the root helper (A7.1) and the storage unlock daemon (A7.12) are one-shot.
- **Command runner:** all shell execution goes through one module (logging, dry-run, sudo announcement, root helper, mockable).
- **Environment hygiene:** run from inside a Claude Code session, devhost drops that session's own variables (`CLAUDE_CODE_SESSION_ID`, `CLAUDECODE`, bridge variables) before starting any `claude`, so its telemetry is never attributed to that session.

## A6. Configuration

`~/.config/devhost/config.yaml`, created by `devhost init`, validated against a JSON Schema on every command. The schema lives in the shared `contract` package (A15).

```yaml
machine:
  hostname: macmini
  rootHelper: false                  # true: passwordless root helper for devhost's own operations (A7.1)
  power: { neverSleep: true, autoRestartAfterPowerLoss: true, wakeOnLan: true }   # false = leave alone

storage:                             # optional; omit = everything stays on the internal disk (A7.12)
  workVolume:
    label: devwork                   # volume name, mounted at /Volumes/<label>
    uuid: "<APFS volume UUID>"       # identity check; never trust the path alone
    encrypted: true
    root: /Volumes/devwork/work      # account roots default to <root>/<account>
    spotlight: false                 # mdutil -i off on the volume
    alerts: { freePercent: 15 }

accounts: []                         # empty after init; managed by `devhost account ...` (A7.11)
# Example entries as written by `devhost account add`:
#  - name: personal
#    default: true                    # uses Claude Code default config dir, CLAUDE_CONFIG_DIR unset
#    configDir: null
#    root: ~/work/personal            # <storage.workVolume.root>/personal when a work volume is set
#    portRange: [3000, 3999]          # allocated automatically: next free 1000-port block from 3000
#    git: { name: "Adam Banky", email: "<personal email>" }
#    claudeLogin: me@example.com      # recorded at the first `devhost login` (A7.10)
#    alerts: { dailyCostUsd: null }   # estimate; null = no alert
#  - name: business
#    default: false
#    configDir: ~/.claude-business
#    root: ~/work/business
#    portRange: [4000, 4999]
#    git: { name: "Adam Banky", email: "<business email>" }
#    claudeLogin: me@work.example
#    alerts: { dailyCostUsd: 50 }

environments:                        # managed by `devhost env ...`, editable by hand
  - name: acme-api
    account: business
    repo: git@github.com:acme/api.git    # omit for `git init`
    portBase: 4100                       # allocated automatically if omitted: 100-port block inside portRange
    remoteControl: { enabled: true, spawn: worktree, permissionMode: acceptEdits }
    compose: auto                        # auto (start if compose file exists) | off
    alerts: { dailyCostUsd: 40, hourlyCostUsd: 10 }   # estimates; null or omitted = no alert

packages:
  brew: [git, gh, tmux, mosh, direnv, jq, ripgrep]
  cask: []
  extra: []

runtimes: { node: lts, python: "3.12", ruby: "3.3", php: "8.3" }   # via mise

docker: { runtime: colima, cpu: 6, memoryGiB: 16, diskGiB: 200, idleSleepMinutes: 60 }   # colima | orbstack | none; idleSleepMinutes: 0 = never sleep
                                     # diskGiB defaults lower with a work volume (A7.12)

network: { tailscale: true, ssh: true }

claude:
  install: brew                      # brew | native
  settings:                          # merged into each account's user settings.json
    remoteControlAtStartup: true
    inputNeededNotifEnabled: true
    agentPushNotifEnabled: true
    permissions:
      defaultMode: acceptEdits
      ask: ["Bash(git commit *)", "Bash(git push *)"]

collector:
  port: 4318                         # OTLP/HTTP + hook receiver, bound to 127.0.0.1 only
  sampleIntervalSeconds: 5           # process sampler; Docker, Tailscale and the work volume have their own intervals (A10.9)
  retention: { rawDays: 7, rollupDays: 365, logDays: 7 }
  alerts:
    memoryPercent: 90
    diskFreePercent: 15              # internal disk; the work volume has its own (storage.workVolume.alerts)
  authCheckMinutes: 60
  authProbe: false                   # also verify logins with a cheap `claude -p` call (A10.4)

notify: { provider: ntfy, topic: "<random, generated by init>" }

plugins:                             # A18; built-in ones are on unless enabled: false
  stats: { enabled: true }
  disk-cleanup: { enabled: true, options: { warnGiB: 5 } }
```

## A7. What `apply` sets up

Each item is a **step** with `check()`, `apply()`, and a description. Steps run in order; a failure stops with a clear message and fix hint. Environment steps (`env.<name>`) are independent of each other: a failed one is reported and the run goes on with the next, so one broken environment does not keep the others on an old plist; the command still exits with the first failure.

Step ids include `system.*`, `packages`, `runtimes`, `shell`, `docker.*`, `tailscale`, `claude.binary`, `agents`, `accounts.*`, `collector`, `storage.volume|ownership|spotlight|automount|unlock` (with a work volume, A7.12), `env.<name>` and `services.orphans`; `--only` takes an id or a prefix (`--only storage`). **`services.orphans`** finds `com.devhost.*` LaunchDaemons that nothing in the config asks for any more (a removed environment, Colima after a runtime switch), lists them and removes them only after confirmation; `uninstall` removes them without asking separately. `storage.unlock` compares the unlock service's volume UUID with the configured one and removes the service when no encrypted volume is configured.

**Running sessions are not disturbed.** A Remote Control service is restarted only when what it runs changes (its plist bytes, its login, its working directory). A change elsewhere in the config, a storage step, or a re-run of `apply` leaves a running service and its sessions alone. In particular:
- Without a work volume, every generated plist stays byte-identical to what it was before the storage feature.
- With a work volume, only the services of environments whose directory is on the volume get the readiness gate; the others keep their plist. Adding the gate restarts a service once; it is listed in `--dry-run` as such.
- A storage step that only re-checks an unchanged volume (same uuid, label, mount, encryption) changes nothing and restarts nothing; Colima restarts only when its mount set changes.
- `storage migrate` stops only the migrated account's services.

### A7.1 System

- **Root helper** (`machine.rootHelper: true`): installs `/Library/PrivilegedHelperTools/app.devhost.root` (a JavaScript for Automation script run by `/usr/bin/osascript`, root:wheel 0755) and `/etc/sudoers.d/devhost` (checked with `visudo -c` first) that lets the operator run it, and only it, without a password. It does only fixed, validated operations: install/load/unload/remove devhost's own LaunchDaemons (labels `com.devhost.*`; plists restricted to `Label`, `UserName` = operator, `ProgramArguments`, `EnvironmentVariables`, `WorkingDirectory` inside the home, `/Users/Shared` or the configured work volume (see below), `RunAtLoad`, `KeepAlive`, `ThrottleInterval`), hostname, power, Remote Login. So the app and ssh need nobody at the keyboard. `false` removes both. **Amended (A7.1 vs A7.12):** A7.1 used to confine `WorkingDirectory` to the home while A7.12 puts account roots under `/Volumes/<name>/...`, so every environment on the work volume was refused. The helper now also accepts a path under `/Volumes/<name>` when that mount's `.devhost-volume` holds the same UUID `diskutil info -plist` reports for it, and under `/Users/Shared`; everything else (and any `..`) is still refused. Services log through `/bin/sh` as the operator (`exec >>"$0" 2>&1 && exec "$@"`), never `StandardOutPath` (opened as root).
- Hostname (`scutil` ComputerName / HostName / LocalHostName).
- Power: `pmset -a sleep 0 disksleep 0 autorestart 1 womp 1` per config. A flag set to `false` means "leave alone". `autorestart` is not supported on portable Macs: reported, left alone.
- Remote Login (SSH) on. If macOS blocks the CLI path (Full Disk Access), print exact manual steps.
- `doctor` reports FileVault status (never changed). After a reboot the disk must be unlocked before anything starts.

### A7.2 Packages and runtimes

- Render `Brewfile`, run `brew bundle install --no-upgrade` (brew's output streams while it runs).
- `mise` (own installer into `~/.local/bin`, or one already on `PATH`) installs runtimes with `mise use --global`; shell activation goes into the managed shell block (A7.8).

### A7.3 Docker

- `colima`: install `colima`, `docker`, `docker-compose`, `docker-buildx`; start with configured resources as a boot-time LaunchDaemon (no GUI login). With a work volume, the volume's root is an extra writable mount (A7.12).
- `orbstack`: install the cask; `doctor` warns it needs a GUI login after reboot.
- `none`: skip.

### A7.4 Tailscale

- `sudo brew services start tailscale` (system daemon; runs without a GUI login).
- If not authenticated, print `sudo tailscale up` instructions; do not automate the login.

### A7.5 Claude Code

- Install via the configured method; record the absolute binary path and use it in all plists and scripts (launchd has a minimal `PATH`).
- Per account:
  - Ensure the config dir exists.
  - **Merge** `claude.settings` into the account's user `settings.json`, preserving keys the user or Claude Code added. User-level is required: `remoteControlAtStartup: true` is ignored in project settings, and OTel exporter variables are ignored in a repository's `.claude/settings*.json`.
  - Add the telemetry and hook settings from A10.2 to the same file.
  - Install the shared user-level `CLAUDE.md` (A8) as a managed block in the account's `CLAUDE.md`, keeping the rest of the file.

**Keeping it current (`devhost update`, `claude.update`).** `apply` only installs Claude Code (and updates it when too old for Remote Control); `brew bundle` never upgrades. Updating is its own flow because a Remote Control service starts its sessions from the versioned path (`…/Caskroom/claude-code/<version>/claude`) that `brew upgrade` deletes: until it restarts, a service cannot start new sessions.

1. `brew update`, then the installed version (`claude --version` of the recorded path) against the cask's (`brew info --json=v2 --cask claude-code`). Native installs learn of a new version only by running `claude update`.
2. Sessions in the middle of a turn (collector state `running`, active in the last day): the update **waits** and says which ones, unless `--force`.
3. Before upgrading, note each Remote Control service's open sessions (its child processes started with `--session-id cse_…`) and running reattach jobs (one session each).
4. `brew upgrade --cask claude-code` (native: `claude update`).
5. If the version changed: `launchctl kickstart -k` every Remote Control service, and remove running reattach jobs. The noted sessions are listed with their claude.ai link: a detached session continues under its environment's (restarted) service as soon as someone writes in it on claude.ai (verified October 2026), so nothing is reattached. A reattach job would register its own single-session environment named after the worktree ("bridge-cse_…", "Full · 1 running"), and claude.ai then lists it instead of the environment of the same repository on this machine.
6. Refuses to run from inside a session of a service it would restart (it would end itself half way): run it from the app, a terminal, or let the collector do it.

`--check` only reports; `--all` also upgrades the outdated Brewfile packages (`brew outdated --json=v2`, limited to the Brewfile); `--dry-run` prints the plan.

**Automatically** (`claude.update`, default `auto`): the collector runs `devhost update --check` once a day and keeps the result for the dashboard and doctor. With `auto`, inside `claude.updateWindow` (local time, default `02:00-06:00`) it runs `devhost update` hourly until it succeeds: busy sessions make it wait an hour; a failed update is not retried until the next day's check. Each update and each failure sends a notification. `notify` only notifies, once per new version; `off` does neither.

Doctor warns when another `claude` comes before the recorded one on the services' `PATH` (e.g. a leftover native install in `~/.local/bin`): whatever calls `claude` by name would run that one.

### A7.6 Account routing (direnv)

- Create account roots (never under `/Volumes` unless the work volume is mounted and verified, A7.12).
- For accounts with a non-null `configDir`, write `<root>/.envrc` with `export CLAUDE_CONFIG_DIR=<configDir>` and `direnv allow` it. It lives in the account root, never inside a repo.
- Managed shell block: Homebrew, mise, `eval "$(direnv hook zsh)"`, plus one alias `claude-<name>` per configured account (regenerated when accounts change).
- All paths are **real paths** (no symlinks), also on the work volume.

### A7.7 Git identity

- `~/.gitconfig`: one `[includeIf "gitdir:<real root path>/"]` per account → `~/.config/devhost/git/<account>.gitconfig`.

### A7.8 Shell

- All `~/.zshrc` edits sit inside `# >>> devhost >>>` / `# <<< devhost <<<`. `apply` replaces only that block; `uninstall` removes it.

### A7.9 Environments

For each entry in `environments` (also triggered by `devhost env create`):

1. **Directory:** `<account root>/<name>`. Clone `repo`, or `git init` if none.
2. **Ports:** allocate `portBase` (100-port block inside the account's `portRange`) if missing; persist it to config. No two environments overlap.
3. **`.envrc`** in the environment dir, excluded via `.git/info/exclude` (never committed):
   ```bash
   source_up                                   # inherits the account's CLAUDE_CONFIG_DIR
   export DEVHOST_PORT_BASE=<portBase>
   export OTEL_RESOURCE_ATTRIBUTES="devhost.account=<account>,devhost.env=<name>"
   ```
4. **Compose:** with `compose: auto` and a compose file present, `docker compose up -d` with project name `devhost-<name>` (used by the collector to map containers to environments). The project is up when at least one container runs and every other one exited 0 (a one-shot init service, e.g. creating buckets). A compose network left from before is reported with how to remove it (never removed by devhost).
5. **Remote Control service:** one launchd job per environment with `remoteControl.enabled: true`:
   - LaunchDaemon with `UserName` = operator (starts at boot without GUI login). Label `com.devhost.rc.<account>.<name>`.
   - `WorkingDirectory`: the environment dir. Must be a git repo: `--spawn worktree` requires one. *(This is why Remote Control runs per environment, not per account root.)*
   - `EnvironmentVariables`: `CLAUDE_CONFIG_DIR` (non-null accounts only), `DEVHOST_PORT_BASE`, `OTEL_RESOURCE_ATTRIBUTES` as in the `.envrc`, `PATH` with Homebrew and `~/.local/bin`, `HOME`.
   - `ProgramArguments`: through `/bin/sh`, which appends to the log, writes `[devhost] started <time>`, waits (up to 3 minutes) until `api.anthropic.com` resolves (at boot launchd starts it before the network), then with a work volume `devhost storage wait` (A7.12), then renews the service's bridge pointer (below), then `exec claude remote-control --name <account>-<name> --spawn <spawn> --permission-mode <permissionMode>`.
   - Bridge pointer: Claude Code keeps the environment and session a service last had in `<Claude config dir>/projects/<dir as project name>/bridge-pointer.json` and reuses them on the next start only while the file is younger than 4 hours; a service stopped longer (the machine off overnight) would register a new environment and session, and claude.ai deletes the old environment with its sessions ("environment_deleted", verified October 2026). So the wrapper renews the file's modification time before each start and keeps a copy (`~/.local/share/devhost/rc/<label>.pointer`); a pointer Claude Code did not rewrite (same bytes, not newer than the copy) in three starts in a row is one it cannot start with (e.g. the server no longer has the environment), so it is removed and the service registers anew; the count is kept in `<label>.pointer.tries`. Before touching the pointer the wrapper checks that `claude --version` runs, and exits 75 (launchd retries) when it does not: at boot Gatekeeper can refuse the first exec of the binary ("OS_REASON_EXEC | Gatekeeper policy blocked execution", seen October 2026), and a start that never ran Claude Code must not count against the pointer. Dropping the pointer after a single such start lost every environment, and with them all their sessions, on a reboot. A folder is served by one `remote-control` at a time: the server refuses a second one ("This folder is already served").
   - `KeepAlive: true`, `ThrottleInterval: 30`.
   - Logs: `~/Library/Logs/devhost/rc-<account>-<name>.log` (rotated, A10.3).
6. **Trust:** Remote Control without a TTY exits with "Workspace not trusted" in an untrusted dir. If the environment dir is not trusted, `env create` runs the interactive trust step (A7.10) before starting the service, answering Claude Code's questions on a real pty and checking the trust was recorded; with `--json` it emits a `prompt` event (A9) instead.

A failed `docker compose up` does not stop the setup: the Remote Control service is still installed and started, and the failure is reported at the end (its hint says a session in the environment can fix the compose project). Otherwise a broken compose project could only be fixed outside devhost.

`env create` again for an environment that is in the config continues (or repeats) its setup with the config's settings, e.g. after a failed `docker compose up`.

`docker compose up` and the Keychain: Docker Desktop sets `credsStore: desktop` in `~/.docker/config.json` on every start, and that helper reads the login Keychain, which a session without a GUI login (ssh, as the app runs devhost; LaunchDaemons) cannot use: every pull fails ("error getting credentials … keychain cannot be accessed"), public images included. On that error devhost runs `up` once more with `DOCKER_CONFIG=~/.local/share/devhost/docker`: the user's config without the Keychain helpers (`desktop`, `osxkeychain`), the rest of `~/.docker` linked in (contexts, CLI plugins). Public images then pull; registries logged in to through the Keychain do not. The user's own config is never changed.

`devhost env delete <name>`: stops and removes the service, `docker compose down`, removes the config entry. Deletes the directory only with `--delete-files`, after showing unpushed commits/branches and requiring a typed confirmation of the name.

`env create` refuses to run if the target account does not exist. `--daily-cost-alert <usd>` and `--hourly-cost-alert <usd>` set the new entry's `alerts` (A10.5); later they are changed in the config or in the app (Environments → … → *Cost alerts…*).

**Agents** (step `agents`): `agents: [name, …]` on an account or an environment lists the subagents Claude Code sessions there can use; names come from devhost's built-in catalog (`explorer`, `reviewer`, `test-runner`, `docs`) or the top-level `agents.custom` (`name`, `description`, `prompt`, optional `model`, `tools`). `apply` writes each as a Claude Code agent file (markdown with frontmatter) to `<Claude config dir>/agents/` for an account and `<environment>/.claude/agents/` for an environment. Files carry a mark in the frontmatter (`# managed by devhost`): only marked files are rewritten or removed when the list changes, a file of the same name without the mark is the user's and is left alone. An unknown name is a config error. Running sessions see new agents after they restart. With `agents.delegation: true` the shared CLAUDE.md (A8) gets a short "Subagents" block: hand broad searches, test runs and reviews to the agents above, start independent subtasks in parallel, do small edits yourself. `devhost agents list` returns the catalog, `agents.delegation` and what each account and environment has (`result.agents-list`). The app's **Agents** screen shows it: the catalog, the delegation checkbox, and a grid of agents per account and environment; ticking one runs `config set` (validated by the CLI), and *Apply changes* runs `apply --only agents accounts.claude` in a live dialog.

**Where tokens and cost go** (stats plugin, widget `sources`): Claude Code's `api_request` log events carry `query_source`: the main thread (`repl_main_thread…`), a built-in subagent type (`agent:builtin:<type>`, e.g. Explore), custom agents (`agent:custom:<name>`: the name is not kept, all custom agents count together), compaction. The collector stores it as a short label per request (`api_requests.source`), rolls it up per hour (`rollup_source`, with the raw rows since the last rollup read as for usage) and `dash` returns `sources`: requests, tokens by kind and cost per source for the range and filters. The widget shows the main thread's and the subagents' cost and tokens, and one row per source with its share and tokens per request, so the saving from delegating work (a smaller main context that every later request reads again) shows in the main thread's tokens per request. Requests from before this update have no source and are not listed.

**Token mix and its trend** (stats plugin, widgets `tokens` and `trend`): `dash` returns `tokens`, the same rows as the sources (raw since the last rollup, `rollup_source` before it) per model and usage bucket: requests, tokens by kind and cost. *Token mix* shows each kind's share of the tokens and its estimated share of the cost (Anthropic's price ratios: output 5×, an hour-long cache write 2×, cache read 0.1× the input price; the cost of each kind is not reported apart), a 100 % column chart of the cost split per bucket, and per model the output, context and cost per request and the cache hit rate. Thinking (reasoning) tokens are billed as output and not reported apart: they are in the output. *Per request over time* compares the earlier and the later half of the range (output, context read, cache hit rate, cost per request) and charts the output per request per bucket: with the same kind of work, a step there usually means the model changed (a new version, a different default effort, more thinking). Chart values may use the `percent` format.

**Sleeping environments** (`docker.idleSleepMinutes`, default 60; 0 turns it off): compose services idle most of the time but hold memory, and Docker's VM keeps working for them. The collector checks every minute: an environment whose compose project runs and that had no session activity (hooks of its sessions, worktrees included) for that long, with no session in the middle of a turn, falls asleep: the services running at that moment are noted in `~/.local/share/devhost/sleep/<env>.json`, then `docker compose stop` stops them (containers and volumes stay). The next `SessionStart` or `UserPromptSubmit` hook in the environment wakes it: `docker compose start` of exactly the noted services, so a service stopped by hand before (a model server left off on purpose) stays stopped. A collector start counts as activity, so a restart does not put everything to sleep at once. By hand: `devhost env sleep <name>` and `devhost env wake <name>` (`result.env-change`, action `asleep`/`awake`, the services); `env list` gives a sleeping environment's `asleep` (since, services). While asleep, `apply` does not start the compose project and `doctor` reports it as asleep, not down. Activity outside Claude Code sessions (a browser on a dev server) is not seen: `env wake` brings such an environment back.

**Session reattach** (`devhost session reattach <id> [--dry-run]`): after a reboot a service registers anew and an ended Remote Control session is left without a machine. For a session the service started in its own worktree (`.claude/worktrees/bridge-cse_<id>` ↔ `session_<id>` on claude.ai), runs `claude remote-control --session-id session_<id>` in that worktree as a one-shot LaunchDaemon `com.devhost.reattach.cse_<id>` (`KeepAlive: false`, network wait as above). Reports success only once it connected; a job that cannot connect (the session archived or expired on claude.ai) is removed. Ended reattach jobs are removed on the next reattach and by `uninstall`. Usually not needed: a session whose process is gone continues under its environment's service when someone writes in it on claude.ai. While a reattach job runs, claude.ai lists its single-session environment ("bridge-cse_…") instead of the environment; `devhost update` removes running ones.

### A7.10 Interactive first-run (`devhost login <account> [--switch-login]`)

For what cannot be automated:

1. `claude auth login` in the account's environment. Over SSH the browser cannot reach the local callback; the user opens the URL on any device and pastes the code back.
2. **Identity guard:**
   - The first successful sign-in records the login's email as `accounts[].claudeLogin`.
   - A sign-in as anyone else than the recorded login, or as another account's login (same email and organization), is **signed out again and refused**: running on it, the account's services would register its environments under the wrong claude.ai account and keep them there.
   - `--switch-login` accepts a new login on purpose. On any change of login, devhost forgets the account's Remote Control state (each environment's `bridge-pointer.json`, worktrees included, and `remoteControlMachineId` in the account's `.claude.json`) so the environments register afresh under the new login.
3. **Services' credentials:** the services (LaunchDaemons, outside the GUI session) sign in with `<config dir>/.credentials.json`. A sign-in where the Keychain is writable stores the new login there and leaves that file alone. devhost asks claude.ai's profile endpoint whose login the file holds; if it differs, it copies the Keychain sign-in into the file (mode 600) or refuses with how to sign in so it lands there (from the app or over ssh).
4. Accept workspace trust for each environment dir of the account (start `claude` there once).
5. Accept the one-time "Enable Remote Control?" confirmation (run `claude remote-control` once interactively, then stop).
6. Re-run the account's `doctor` checks; if green, (re)start its environment services (a running service still has the old login).

With `--json`, each human step is a `prompt` event; the URL is emitted as data, the code is read from stdin (A9).

### A7.11 Accounts (`devhost account ...`)

Accounts are data, not built in. `apply` only maintains accounts already in the config.

`devhost account add --name <name> --git-email <email> [--git-name <name>] [--default] [--daily-cost-alert <usd>] [--root <path>] [--no-login]`:

1. Validate: name is a slug and unique; only one account may be `default` (refuse `--default` if one exists, unless `--force-default-switch`, which is out of scope for v1 and fails with an explanation).
2. Allocate the next free 1000-port block (from 3000) and persist it.
3. Set `configDir` (`null` for the default account, else `~/.claude-<name>`) and `root` (`--root`, else `<storage.workVolume.root>/<name>` when a work volume is configured, else `~/work/<name>`).
4. Write the config entry, then run the account-scoped steps of `apply`: config dir, settings merge (A7.5, A10.2), CLAUDE.md, account root + `.envrc` (A7.6), git identity (A7.7).
5. Start the login flow (A7.10). With `--json`, as prompt events. `--no-login` skips it; `doctor` then reports the account as not logged in.

`devhost account remove <name>`:

- Refuses while the account has environments (list them; remove those first).
- Removes the config entry, `.envrc`, git `includeIf`, devhost-managed keys from its `settings.json`.
- Never deletes the account root, the Claude config dir, or credentials. `--logout` additionally runs `claude auth logout` in the account's environment.

`devhost account list`: name, default flag, config dir, root, port range, logged in, environment count.

### A7.12 Storage: external work volume

Optional (`storage.workVolume`). Keeps the internal SSD for the system and moves bulky project data to one external APFS volume, without breaking headless boot, launchd services, Docker bind mounts, or path-based tooling (direnv, git `includeIf`, Claude Code workspace trust).

| On the work volume | Always on the internal disk |
| --- | --- |
| Account roots and everything under them (environments, worktrees, `node_modules`) | macOS, Homebrew, mise, `~/.config/devhost`, Claude config dirs and credentials, collector DB, Colima VM disk, logs |

- **Real paths everywhere, no symlinks:** `.envrc`, git `includeIf "gitdir:…"`, launchd `WorkingDirectory`, Colima mounts, and anything Claude Code stores. An optional `~/work` convenience symlink may exist; no generated config references it.
- **Identity:** the volume is the configured one only when it is mounted at `/Volumes/<label>`, `diskutil info` reports the configured APFS volume UUID, **and** `<mount>/.devhost-volume` holds that UUID. Never trust the path alone.

Steps (each announced; the sudo ones go through the root helper where it can, else sudo):

1. **Ownership:** `diskutil enableOwnership <volume>` (external volumes ignore ownership by default, which breaks git, ssh, and file modes).
2. **Spotlight:** `mdutil -i off <mount>` when `spotlight: false`.
3. **Mount without login:** set `AutomountDisksWithoutUserLogin` in `/Library/Preferences/SystemConfiguration/autodiskmount` (sudo, announced). Verify on macOS 26 that this is still needed and still works (A14).
4. **Encrypted volume unlock at boot (no GUI login):**
   - The passphrase is a generic password in the **System keychain** (service `devhost.workvolume`). The internal disk is FileVault-protected, so the key is protected at rest by FileVault.
   - A root LaunchDaemon `com.devhost.storage.unlock` runs at boot: `diskutil apfs unlockVolume <uuid> -stdinpassphrase` with the passphrase piped from `security find-generic-password -w`, then exits.
   - The passphrase never appears in argv, config, logs, the DB, or `--json` output.
   - `devhost storage set-passphrase` (stdin only) writes or rotates the keychain item.
   - The root helper gains exactly these operations (validated like the others): install/remove the unlock daemon, write the keychain item from stdin, `enableOwnership`, `mdutil`, the autodiskmount preference.
5. **Readiness gate for every dependent launchd job:** Remote Control services, session reattach jobs, and compose start-up **of environments on the volume** run through `devhost storage wait && exec <original command>`. Environments on the internal disk keep their plists unchanged (A7, running sessions are not disturbed).
   - If the volume is missing, the job exits non-zero and launchd retries (existing `ThrottleInterval`).
   - The collector alerts once per state change, not per retry (A10.5).
6. **Colima mounts:** Colima only mounts `$HOME` by default. Add `workVolume.root` as a writable mount (virtiofs) in the generated Colima config and restart Colima only when the mount set changed. Without this, compose bind mounts from the volume silently mount empty directories.
7. **Docker disk:** the Colima VM disk stays internal. When a work volume is configured, the default `docker.diskGiB` is lowered to fit a 512 GB internal disk, and `doctor` warns if `diskGiB` > 40 % of internal free space.

Commands (`devhost storage …`, A11):

- `list`: external physical disks and volumes (`diskutil list -plist external physical`, `diskutil info -plist`).
- `adopt <volume>`: register an existing APFS volume. Writes uuid and label to the config and `<mount>/.devhost-volume` containing the uuid.
- `prepare <disk>`: **destructive**, CLI only, never from the app or `apply`. Shows disk model, size, and current volumes. Requires typing the disk identifier and `--yes-erase`. Erases as APFS (encrypted if configured); the passphrase is read from stdin, never from argv. Then runs `adopt`.
- `status [--json]`: mounted, uuid match, marker, encryption state, ownership, free space, Spotlight.
- `wait [--timeout 300]`: exit 0 only when the volume is mounted **and** its uuid matches **and** the marker matches. Never creates anything under `/Volumes`.
- `set-passphrase`: A7.12 step 4.
- `migrate --account <a> [--cleanup]`: stops that account's services, `rsync -aH` the root to the volume, verifies (file count and size), updates the config, regenerates `.envrc`, `includeIf`, plists, and Colima mounts, then re-runs workspace trust for the moved environments (prompt events). The old copy is kept until `--cleanup` (which asks for confirmation). Warns that Claude Code session history is keyed by project path and does not follow the move, and that Remote Control sessions of the old paths end.

## A8. Generated user-level CLAUDE.md

```markdown
## Working rules
- Break every task into phases. After the plan, wait for approval.
- At the end of each phase: run tests and linters, write a summary of max. 5 lines
  (what changed, test results, open questions), send a push notification, and STOP.
- Commit only after explicit approval. Push only to feature branches, never to main.
- Dev servers: bind to 0.0.0.0 and use a free port between $DEVHOST_PORT_BASE and
  $DEVHOST_PORT_BASE+99 (parallel worktrees run side by side).
  Report the URL as http://<hostname>:<port>.
```

Binding to `0.0.0.0` is what makes a dev server reachable over Tailscale, and it also exposes it on every other network the host is on (the LAN), with only the project's own authentication. The block is the single place to narrow that (for example to the Tailscale address); with `agents.delegation: true` a `## Subagents` section follows it.

## A9. Machine-readable contract (`--json`)

Every command accepts `--json`. The contract is versioned and lives in the shared `contract` package as JSON Schemas with generated TypeScript types.

- **Short commands:** one JSON object on stdout: `{ "contractVersion": 1, "ok": true, "data": {...}, "errors": [] }`.
- **Long-running commands** (`apply`, `env create`, `login`, `dash --follow`, `plugin run`, `session reattach|handoff`, `storage prepare|migrate`): NDJSON on stdout, one event per line:
  - `{"type":"step","id":"docker","status":"start|ok|changed|skipped|failed","message":"..."}`
  - `{"type":"log","level":"info|warn|error","message":"..."}`
  - `{"type":"prompt","id":"auth-code","kind":"open-url|input|confirm","url":"...","message":"..."}` → answered by writing `{"id":"auth-code","value":"..."}` as one line to stdin
  - `{"type":"result","ok":true,"data":{...}}` as the last line
- **Exit codes:** 0 ok · 1 checks failed · 2 usage/config error · 3 human action required · 130 cancelled (SIGINT).
- **Cancellation:** SIGINT stops after the current step, leaving a consistent state.
- The envelope schema also allows `contractMinor` (additive revision within a major, never removals) and `capabilities` (optional features such as `snapshot-event`); both are constants of the contract package, bumped by the versioning test in `packages/contract/test`, and not yet printed by the CLI. `devhost version --json` returns CLI version, `contractVersion`, and `host.name` (the configured `machine.hostname`, else the system host name); the app refuses to run against an incompatible major and names the host by `host.name`.
- Human output and JSON output are produced from the same data; JSON never contains ANSI codes.
- Secrets (the storage passphrase) are never part of any event, result, or error.

## A10. Collector and dashboard data

A single long-running process, `devhost collector`, run by launchd (LaunchDaemon, `UserName` = operator, `KeepAlive`). It **absorbs the auth watcher** and stores everything in SQLite at `~/.local/share/devhost/devhost.db`. It binds to `127.0.0.1` only; remote access is only via SSH (`devhost dash`).

### A10.1 Data sources

| Source | What it gives | How |
| --- | --- | --- |
| Claude Code OpenTelemetry (OTLP/HTTP JSON) | Tokens by type (`input`, `output`, `cacheRead`, `cacheCreation`) and model, estimated cost, sessions started, active time, lines changed, commits, PRs; per request via `claude_code.api_request` events with `session.id` and `duration_ms`; per tool run via `claude_code.tool_result` events (tool name, `duration_ms`, success only; never its input or output) | Collector implements a minimal OTLP/HTTP JSON receiver (`/v1/metrics`, `/v1/logs`) |
| Claude Code HTTP hooks | Session lifecycle and live state: started, prompt submitted, waiting for input, stopped, ended; subagents started/stopped; `cwd` → environment | Collector endpoint `/hooks`; hooks configured in each account's user settings |
| Process sampler | CPU % and RSS per environment (process tree of its launchd job) and system totals, swap in use and the kernel's memory pressure level (`sysctl vm.swapusage kern.memorystatus_vm_pressure_level`); per Remote Control session (the service's child started with `--session-id cse_<id>` and its subtree; never `lsof`): a worktree session by its directory, one in the environment's folder by `<Claude config dir>/sessions/<pid>.json`, where Claude Code keeps the process's session and its claude.ai session (`bridgeSessionId`, kept in `sessions.remote_session`); such a session whose process is gone, quiet for 10 min, is marked ended, any other after 24 h without hooks | one `ps -axo pid,ppid,pcpu,rss,command` every `sampleIntervalSeconds`, the services' pids from launchd once a minute |
| Agents | Sessions running a turn plus the subagents they started, sampled; most at once per bucket | From hook state every sample |
| Docker | CPU / memory per container, mapped to environments via compose project `devhost-<name>` | `docker stats --no-stream --format json` every 15 s |
| Disk | Free space of the internal disk and, when configured, of the work volume; size per environment (worktrees, `node_modules`), wherever it lives | Free space every sample; per-env `du` daily |
| Work volume | Mounted, uuid match, marker, double mount, free space | Every 60 s (A7.12, A10.9) |
| Auth | Login valid per account and which login it is (email, organization) | `claude auth status` every `authCheckMinutes` (see A10.4) |
| Session titles | The session's custom title, else its last prompt, for the dashboard only | Read from the transcript on request; never stored |

**Attribution:** every OTel datapoint carries `devhost.account` and `devhost.env` from `OTEL_RESOURCE_ATTRIBUTES` (set by the launchd job or `.envrc`), plus Claude Code's own `session.id` and `user.email`/`organization.id`. A login seen in a session's telemetry that belongs to exactly one account decides that session's account (a login two accounts share decides nothing). Sessions started outside any environment fall back to `user.email` → account mapping and `env = null`.

### A10.2 Settings written per account (user-level `settings.json`)

**Receiver checks.** The collector listens on `127.0.0.1` only and, before reading a body, refuses (403) any request that has an `Origin` header (no browser page, against CSRF) or a `Host` other than `127.0.0.1:<port>` (DNS rebinding), and, on `/v1/metrics`, `/v1/logs` and `/hooks`, (401) a request without the per-install bearer token, sent as `Authorization: Bearer <token>` (OTLP headers) or `?token=` (hook URL) and compared in constant time. The token is random, created on first use at `~/.local/share/devhost/collector-token` (mode 600) and written by `apply` into each account's settings. Only `application/json` is accepted. `/health` needs no token.

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318",
    "OTEL_METRIC_EXPORT_INTERVAL": "15000"
  },
  "allowedHttpHookUrls": ["http://127.0.0.1:4318/hooks*"],
  "hooks": { "...": "HTTP hooks for SessionStart, UserPromptSubmit, Notification, Stop, SessionEnd, SubagentStart, SubagentStop → http://127.0.0.1:4318/hooks?account=<account>" }
}
```

- `OTEL_RESOURCE_ATTRIBUTES` is **not** set here: it differs per environment and comes from the process environment.
- **Privacy:** `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` stay unset. Hook handlers store only event type, session id, cwd, timestamps, subagent id and type; never prompt text or tool input. Client code and prompts must never reach the database.

### A10.3 Storage and retention

- Raw samples and events: `retention.rawDays`. Hourly rollups (per account, environment, session, model): `retention.rollupDays`.
- Service logs (`~/Library/Logs/devhost/*.log`): rotated once a day into `<log>.1.gz` … (emptied in place; the services append), kept `retention.logDays` (default 7) days; a log nothing wrote to for that long is removed.
- Schema migrations versioned; the collector migrates on start.

### A10.4 Auth check (replaces a separate watcher)

- Per account, `claude auth status` with the account's environment. **Default account: run with `CLAUDE_CONFIG_DIR` explicitly unset** (`env -u`); setting it to `~/.claude` would read a different macOS Keychain entry.
- Non-zero exit → notify: `Claude login not valid: <account>. Run: devhost login <account>`. Once per state change, plus a reminder every 24 h while broken.
- `collector.authProbe: true` adds a cheap probe (`claude -p "ok" --max-turns 1`, costs a few tokens) for the case where `auth status` stays green for an expired login.
- Each valid check records the login's email and organization for attribution (A10.1).

### A10.5 Alerts

Notify (ntfy in v1, provider behind a small interface) when: memory above `alerts.memoryPercent` for 5 min; free internal disk below `alerts.diskFreePercent`; an account's estimated daily cost crosses that account's `alerts.dailyCostUsd`; an environment's estimated cost since midnight crosses its `alerts.dailyCostUsd`, or its cost over the last 60 minutes crosses its `alerts.hourlyCostUsd` (rolling window, high priority; the message names the session that spent most, to catch one stuck in a loop; it clears below 80% of the limit so it does not flap); cost alerts only notify, they never stop a session; a Remote Control service restarts more than 3 times in 10 min; auth invalid (A10.4). With a work volume: volume missing or unmounted (including hot-unplug), uuid or marker mismatch, **double mount** (`/Volumes/<label> 1` exists), free space below `storage.workVolume.alerts.freePercent`. One notification per condition per state change. **Privacy of the channel:** the default server is the public relay `https://ntfy.sh` (`notify.server` can point to one's own), each message is a plain POST to `<server>/<topic>` (title, priority, tags, short text), the relay and anyone who knows the topic can read it, and no message contains prompt text (a title derived from the user's last prompt is never used).

### A10.6 Query interface

- `devhost dash --json [--range 1h|24h|7d|30d] [--account a] [--env e] [--model m]`: snapshot for the dashboard (B3.1): host health, accounts, environments, sessions (with title, subagents, and the Remote Control session id of worktree sessions), usage, agents, models, and with a work volume its capacity, free space, and state.
- `devhost dash --follow --json`: NDJSON stream of live updates every `sampleIntervalSeconds`.
- `devhost top`: the same snapshot as a refreshing terminal table (accounts, environments, sessions, CPU, RAM, tokens today). Usable over SSH from a phone. No charts.
- Plugins read the same data through `ctx.stats()` (A18); the dashboard statistics are the built-in `stats` plugin's.
- **Context habits** (`context` in the range parts; the `stats` plugin's "Context" card): main-thread requests whose context (input + cache read + cache write) is 300K or more, and their cost; **cold resumes**, a main-thread request more than an hour (the prompt cache's TTL) after the session's previous one that writes at least 20K and half its context to the cache, and their cost; and the sessions whose last context is over 300K. The card warns when large requests are 25 % of the cost, cold resumes 10 %, or a large session exists. Each session in the snapshot carries `contextTokens` (its last main-thread request's) and `handoffAt` (A10.10).

### A10.7 Known limits (document in README and show in the UI)

- **Cost is an estimate** (Claude Code reports estimated USD). On subscriptions it is API-equivalent value, not billed money.
- **Subscription plan limits** (session / weekly usage) are not in the OTel data. Show them only if a supported non-interactive way to read them exists; otherwise omit.
- **Per-session CPU/RAM** only for Remote Control sessions (by process tree); per-environment numbers are reliable.
- Sessions on other machines (cloud sessions, the MacBook) are out of scope; the dashboard shows the Mac mini only.
- Claude Code session history is keyed by project path: it does not follow an environment moved by `storage migrate`.

### A10.8 Where agents spend their time, and memory

Question it answers: how much of agent time is this host's, i.e. what a faster or bigger host would shorten.

- Each `api_request` and `tool_result` event ends at its timestamp and lasted `duration_ms`. Per session the intervals are merged, so parallel subagents and tool calls count once.
- Tools are classed: **local** (run here: Bash, Read, Edit, Write, Glob, Grep…), **network** (WebFetch, WebSearch, `mcp__*`), **wait** (AskUserQuestion, plan mode, ScheduleWakeup, Monitor), **nested** (Task/Agent: the subagent's own requests and tools count instead).
- **Busy** = model ∪ local ∪ network. **Model** = API requests (Anthropic's side). **Local only** = local tool time with no API request or network tool in flight in that session: the part a faster host can shorten. Its **CPU-bound** share is the share of the session's process-tree CPU samples taken in local-only time that used at least half a core; the rest waits on disk, network calls inside Bash (npm, git) or sleeps. "2× / 4× faster CPU" = CPU-bound × (1 − 1/k) as a share of busy (Amdahl; nothing else speeds up).
- **Memory:** the largest session's process-tree RSS, the system's peak use, peak swap, and the share of samples with memory pressure at warning or critical. Swap and pressure mean a bigger host would help even where the CPU idles.
- Nothing before the first `tool_result` event counts (earlier time has API requests only): `profile.since`. Hourly rollups (`rollup_profile`, `rollup_tools`, `rollup_memory`) keep it for `rollupDays`.
- Shown by the built-in `stats` plugin: "Where the time goes" (shares, hours, the faster-CPU estimate, time per tool) and "Memory", both following its range, account and environment filters; in `devhost dash --json` as `profile`.

### A10.9 Collector load

The collector runs on the host it measures, so it must stay light:

- **One process listing per tick.** One `ps -axo pid,ppid,pcpu,rss,command` per sample, attributed in memory: environments by their launchd job's process tree, Remote Control sessions by their `--session-id` child; session → environment comes from the hooks' `cwd`. Never `lsof` in a periodic path (it collects every open file of the processes it is given). The doctor's port check is a bind test per port, then `lsof -nP -iTCP:<port> -sTCP:LISTEN` for a busy port only.
- **Single-flight with timeouts** for every external command source: at most one run at a time per source; a tick that finds the previous run still going is skipped, logged once until the source completes. Intervals: processes `sampleIntervalSeconds` (5 s), Docker 15 s, Tailscale 60 s, the work volume 60 s, the services' pids from launchd 60 s (sooner when `ps` no longer shows the pid), disk usage daily, auth `authCheckMinutes` (60).
- **Tailscale**: macOS's `tailscale` CLI runs `lsof -c IPNExtension` on every call to look for the GUI app's API (`safesocket_darwin.go`), even with the open source `tailscaled`. The collector asks tailscaled's LocalAPI directly on its unix socket (`GET /localapi/v0/status?peers=false` on `/var/run/tailscaled.socket`): no child process. `dash`, `doctor` and `status` read the collector's sample (under 3 min old) instead of asking. With a GUI variant (no socket) the CLI is used (`status --json --peers=false`, 5 s timeout) and `doctor` warns, recommending tailscaled on a server (Tailscale's macOS variants: App Store, Standalone, open source `tailscaled`).
- **Precomputed snapshot.** Each tick the collector writes the dashboard's state now to kv `snapshot` (host, collector, alerts, accounts, environments, sessions with their custom titles, re-read only when a transcript's size or mtime changed; a title taken from the user's last prompt is never stored in the snapshot or sent in a notification (A10.1, A13), `dash` reads it from the transcript when it computes the dashboard; volume, updates) plus the 24 h range parts, refreshed every minute. `dash` and the plugins only read it; another range adds its parts from the hourly rollups plus at most an hour of raw rows read through ts indexes; filters compute the snapshot. `dash --follow` emits only when the snapshot changed and computes nothing else. Without a snapshot (no collector) it is computed, and a snapshot the collector stopped writing reports the host offline.
- **Self-monitoring**: every sample records the collector's CPU %, RSS, child processes and overlapping ones (`samples_collector`). `doctor` fails `collector.load` when the CPU averaged over 5 minutes is above 3 % or any command overlapped itself.
- **Regression**: `npm run soak [-- minutes]` runs a second collector (this host's config and database copied to a temporary home, its own port, no automatic updates) with `dash --follow` for 10 minutes and an `lsof` shim on `PATH`: fails on any `lsof` call, collector CPU averaging 3 % or more, or an overlapping child.

### A10.10 Handoff notes

A session left alone for an hour loses its prompt cache, and a Remote Control session often its process too; continuing it then costs a full cache write, and a new session starts without its context. A handoff note is a summary a new session can continue from.

- **Written by a fork:** `claude -p --resume <id> --fork-session --no-session-persistence --settings '{"disableAllHooks":true}' --model <its last model> <prompt>` in the session's directory, with its account's config dir and `devhost.account`/`devhost.env` OTel attributes. The session itself is untouched, the fork is not kept and fires no hooks (no SessionStart: it is not a session to track or a reason to wake a sleeping environment). The prompt asks for the goal and constraints, what is done and committed, key files and facts, decisions, open items and next steps, and the user's preferences, in at most about 600 words, without tools.
- **Cost:** the fork misses the session's prompt cache (measured: a 38K-token session wrote 38.5K tokens to the cache, $0.36, in 27 s), so a note costs about one cache write of the session's context.
- **Automatic:** every minute the collector writes a note for a session idle or waiting for `claude.handoff.idleMinutes` (default 55, just under the cache's hour; 0 turns it off) whose last main-thread context is at least `claude.handoff.minContextTokens` (default 50,000), once per quiet spell, and sends a notification (`memo`). Only sessions that went quiet within the last 15 minutes past the mark: a collector that was off does not write notes for every old session at once. A failed note is not retried until the session is active again.
- **Stored** in `~/.local/share/devhost/handoff/<session id>.md`; `handoffAt` in the dashboard is its mtime.
- **On demand:** `devhost session handoff <id> [--new]` (A11) shows the note written since the session's last activity, or writes one (`--new` always writes); refused for a session in the middle of a turn (`session-busy`). In the app: Sessions → Open → "Write a handoff note" / "Handoff note", shown with a copy button.

## A11. CLI surface

| Command | Behavior |
| --- | --- |
| `devhost init` | Interactive wizard → `config.yaml`; generates the ntfy topic. Refuses to overwrite without `--force`. |
| `devhost apply [--dry-run] [--only <step>]` | Idempotent setup. `--dry-run` prints the plan, including every command needing sudo. |
| `devhost doctor` | Read-only checks (A12); ✅/⚠️/❌ with one-line fixes and plugin advice; exit 1 on any ❌. |
| `devhost status` | One-screen summary. |
| `devhost account list \| add \| remove` | A7.11. |
| `devhost login <account> [--switch-login]` | A7.10. |
| `devhost env list \| create \| delete \| start \| stop \| restart \| sleep \| wake \| logs` | A7.9. `create` flags: `--account`, `--name`, `--repo`, `--no-rc`, `--compose auto\|off`, `--spawn worktree\|same-dir`, `--permission-mode`, `--daily-cost-alert`, `--hourly-cost-alert`. |
| `devhost session reattach <id> [--dry-run]` | A7.9. |
| `devhost session handoff <id> [--new]` | A10.10. |
| `devhost update [--check] [--all] [--force] [--dry-run]` | A7.5: update Claude Code, restart the Remote Control services onto it, list their detached sessions (they continue from claude.ai); `--all` also upgrades the Brewfile packages. |
| `devhost storage list \| adopt \| prepare \| status \| wait \| set-passphrase \| migrate` | A7.12. `prepare` and `migrate --cleanup` are the only destructive paths; never run by `apply` or the app (`prepare`). |
| `devhost plugin list \| run \| widgets \| install \| uninstall \| enable \| disable` | A18. |
| `devhost config get \| set \| validate \| edit \| raw \| put` | Read and change config with schema validation; `set` takes a JSON pointer and value; `raw`/`put` for the app (comments kept, `put` only if valid). Changing config does not apply it; run `apply`. |
| `devhost dash`, `devhost top` | A10.6. |
| `devhost collector run \| logs` | Foreground run (launchd, debugging); its log. |
| `devhost notify --test` | Test notification. |
| `devhost version` | A9. |
| `devhost uninstall [--keep-packages] [--purge-data] [--purge-storage] [--dry-run]` | Removes launchd jobs (session reattaches and orphaned `com.devhost.*` services included), the managed shell block, generated files (with backups). Never deletes projects, Claude config dirs, credentials, or the database unless `--purge-data`. Never touches the work volume, its data, the keychain item, or the unlock daemon unless `--purge-storage`, and even then never erases the volume. |

Global flags: `--json`, `--verbose`, `--yes`, `--config <path>`.

## A12. `doctor` checks (minimum)

macOS version, architecture (Apple Silicon or Intel; not Rosetta), FileVault, hostname · power settings · SSH · root helper (when configured) · Homebrew + `brew bundle check` · runtimes · Docker running · Tailscale running, authenticated, its hostname/IP, the GUI variant on a server (warn: recommend tailscaled) · Claude Code version, a newer one available (from the collector's daily check), another `claude` shadowing it on the services' `PATH` · per account: config dir, required settings keys, logged in, **who it is signed in as** (the services' `.credentials.json` login via claude.ai's profile endpoint; fails if it differs from `claudeLogin` or from what `auth status` shows, or if two accounts share a login), credential store, Remote Control eligibility (`claude doctor`) · per environment: directory is a git repo, trusted, launchd job loaded and running, the Remote Control log since its last start without errors (a sign-in error, expired token or 401, fails with `devhost login <account>`), port block free of conflicts, compose services up, git `includeIf` returns the right email · collector running, receiving OTel data in the last hour, database size, its own load (CPU over 5 min under 3 %, no overlapping child commands) · direnv: `CLAUDE_CONFIG_DIR` resolves correctly in each account root and environment · free internal disk · plugins: each enabled plugin's checks (`plugin.<name>.<check>`; one that does not load is a warning) and their advice under other checks.

**Work volume** (when configured): volume present and mounted, uuid and marker match, APFS, encryption matches the config, ownership enabled, Spotlight state, `AutomountDisksWithoutUserLogin` set, unlock daemon loaded and keychain item present (if encrypted; existence only, never read in doctor), no stray non-mount directory at `/Volumes/<label>`, no double mount, Colima mounts the volume's root and `docker run --rm -v <root>:/x alpine ls /x` sees real files, every account root and environment resolves (realpath) inside the volume, free space, `docker.diskGiB` ≤ 40 % of internal free space.

## A13. Safety rules

- Timestamped backup before modifying any existing file (`.devhost-bak-YYYYMMDD-HHMMSS`).
- Every `sudo` listed in `--dry-run` and announced with its reason; root operations go through the root helper's fixed, validated operations when it is installed.
- No tokens, keys, or passwords in config, templates, logs, database, or repo. The ntfy topic is the only quasi-secret; warn that anyone with it can read notifications. Copying a login into `.credentials.json` (A7.10) writes it with mode 600 and never logs it.
- The storage passphrase lives only in the System keychain; it is read from stdin when set and never appears in argv, config, logs, the DB, or JSON output.
- No prompt text, model output, tool input, or file content collected (A10.2).
- `apply` and `env create` safe to interrupt and re-run.
- **Never `mkdir` under `/Volumes`.** A non-mounted `/Volumes/<label>` path is an error, not a directory to create; this prevents writing project data onto the internal disk.
- `storage prepare` and `storage migrate --cleanup` are the only destructive storage paths. Both require explicit confirmation and are never run by `apply`; `prepare` is never offered by the app.
- An action that removes or stops something (plugin actions marked destructive, env delete, account remove) asks first; `--yes` answers.

## A14. Verify against current docs before implementing

Check official sources; do not rely on memory:

- Claude Code install methods (Homebrew cask name, native installer) and auto-update behavior.
- `claude remote-control` flags and behavior under launchd (non-TTY): trust, one-time confirmation, `--spawn worktree` requirements, `--session-id`, `--continue`, `bridge-pointer.json`, `remoteControlMachineId`.
- Whether trusting a parent directory covers new subdirectories.
- `claude auth status` exit codes and JSON fields; where a sign-in stores credentials (Keychain item name per config dir vs `.credentials.json`) and which one a LaunchDaemon reads.
- Settings keys used in A6 and A10.2; HTTP hook configuration schema, event names, payload fields.
- OTel variables, metric/event names and attributes; OTLP/HTTP JSON payload format.
- Headless Tailscale install on macOS; Colima start-at-boot; Remote Login from CLI on the current macOS.
- **Work volume (A7.12):**
  - `AutomountDisksWithoutUserLogin` on macOS 26, and when external APFS volumes mount relative to LaunchDaemon start.
  - Pre-login unlock of an encrypted APFS volume via `diskutil apfs unlockVolume -stdinpassphrase` from a root LaunchDaemon; System keychain access from that context.
  - `diskutil enableOwnership` behavior on APFS external volumes.
  - Colima mount configuration format and mount type on the current version.
  - Whether Claude Code workspace trust is stored by real path (affects `migrate`).
  - *Checked on macOS 26.4 while implementing:* `diskutil apfs unlockVolume` takes `-stdinpassphrase` and a volume UUID as identifier; `diskutil enableOwnership` needs root; `diskutil apfs encryptVolume <vol> -user disk -stdinpassphrase`; APFS free space is `APFSContainerFree` (`FreeSpace` is 0); `diskutil list -plist external` includes disk images, so disks come from `external physical`; Colima 0.10.3 takes `--mount <dir>[:w]` with virtiofs by default, and an explicit `--mount` replaces the default home mount (so `$HOME:w` is passed too). Not checked (no external SSD on the build host): `AutomountDisksWithoutUserLogin` and the pre-login unlock at boot.

## A15. Repository layout and quality

```
bootstrap.sh
SPEC.md
packages/
  contract/     # JSON Schemas (config, command outputs, events) + generated TS types
  cli/          # devhost CLI + collector
    src/{cli.ts, config/, steps/, collector/, doctor/, plugins/{api,builtin/}, runner/, storage/}
    templates/  # incl. the root helper (devhost-root.js)
  app/          # Part B (Tauri: src-tauri, core/ for the testable Rust shell logic)
```

- Unit tests: config validation, template rendering, step `check()` logic with mocked runner, port allocation, OTLP/hook parsing, rollups, log rotation, plugin API.
- Contract tests: every `--json` output validates against its schema.
- UI tests drive the app's screens against the real CLI (in-process, on a fake Mac).
- `npm run check` (lint, typecheck, tests, Rust tests) runs locally before every push.
- CI (GitHub Actions): lint, typecheck, tests, build, shellcheck, `apply --dry-run` smoke test, the universal app build. **Run by hand for now** (`workflow_dispatch`; the app build only when asked): pushing to the pull request on every commit spent the free macOS minutes.
- README: quick start, steps, re-login, environments, plugins, storage, dashboard limits, troubleshooting.

## A16. Acceptance criteria (Part A)

1. Fresh macOS: `bootstrap.sh` → `init` → `apply` → `account add --name personal --default` → `account add --name business` (each with login) → `doctor` all green. Right after `init` + `apply`, with zero accounts, `doctor` is green except a warning that no accounts exist.
2. A third account added with `account add` works the same way, gets its own port block and config dir, and appears in the dashboard.
3. A second `apply` reports no changes.
4. `devhost env create --account business --name demo --repo <url>` creates a working environment; its Remote Control session appears in the Claude app under the business account.
5. `devhost account remove` refuses while the account has environments; after its environments are removed, it removes the account without touching its root, config dir, or credentials.
6. After reboot (and FileVault unlock), with no GUI login: all environment sessions reappear within 2 minutes; Docker, Tailscale, collector up. A service started before the network waits for it instead of failing.
7. Killing a `claude remote-control` process: launchd restarts it within 60 s.
8. Logging out an account: notification within one auth interval; `devhost login <account>` restores it.
9. Inside a business environment, `claude` uses the business account, `git config user.email` is the business email, `DEVHOST_PORT_BASE` is set.
10. After a session in each account, `devhost dash --json` shows all sessions with tokens, estimated cost, and environment attribution; the database contains no prompt or code text.
11. `devhost uninstall` leaves projects, Claude config dirs, credentials, and (without `--purge-data`) the database untouched.
12. `devhost login business` signed in with the personal login is refused and signed out again; `doctor` reports whom each account's services run as.
13. An ended Remote Control worktree session comes back with `devhost session reattach <id>`; one gone on claude.ai fails and leaves no job behind.

**Work volume (A7.12):**

14. `storage adopt` + `apply`: new accounts land on the volume; `doctor` is green. Sessions of environments on the internal disk keep running through it (no service restarted), and without a work volume `apply` after this phase changes no plist.
15. Reboot with FileVault unlock and no GUI login: the encrypted volume unlocks and mounts, then Remote Control services start; no service starts before the volume is ready.
16. Unplug the volume: alert within one sample interval; services stop retrying noisily; no files are created under `/Volumes/<label>` on the internal disk. Replug: services recover without manual action.
17. A compose service with a bind mount from an environment on the volume sees real files.
18. `storage migrate` moves an existing account. Its environments work afterwards, with git email, `CLAUDE_CONFIG_DIR`, and Remote Control correct; the old copy remains until `--cleanup`.
19. The passphrase does not appear in any log, config, DB row, process list, or JSON output (grep test).

## A17. Delivery phases (Part A)

1. Contract package, config schema, `init`, runner, `apply --dry-run` with system + packages. *(done)*
2. Docker, Tailscale, Claude Code install, settings merge, CLAUDE.md, direnv, git identity. *(done)*
3. Accounts (`account` commands), environments (`env` commands), Remote Control services, `login`, JSON events and prompts. *(done)*
4. Collector: OTLP receiver, hooks, process and Docker samplers, storage, auth check, alerts, `dash`, `top`. *(done)*
5. `doctor`, `status`, `uninstall`, README, CI. *(done)*
6. Operations: root helper, Intel support, plugins (A18), session reattach, login identity guard and services' credentials, boot network wait, log retention. *(done)*
7. **External work volume (A7.12):** config and schema, `storage` commands, `apply` storage steps (ownership, Spotlight, automount, unlock daemon, readiness gate, Colima mounts, Docker disk), collector sampling and alerts, doctor checks, `migrate`, uninstall rules, app status and Storage panel. *(implemented; acceptance criteria 15 and 16, boot and hot-plug, still to be run on hardware with an external SSD)*

Stop after each phase for review.

## A18. Plugins

A plugin is an ES module whose default export lists what it adds (`packages/cli/src/plugins/api.ts`; `definePlugin` gives the types). It runs in the CLI on the Mac mini, as the operator, uses only the plugin API (`ctx.exec`, `ctx.sessions()`, `ctx.services()`, `ctx.stats()`, …) and Node's own modules, never devhost's other modules, so it can live in its own repository. It changes things only through `ctx.exec`, so `--dry-run`, the plan and the root helper work as for `apply`. **Trust:** a plugin is full-trust code, not a sandbox. It is plain Node.js running as the operator and can read files, use the network and spawn processes without `ctx.exec`; `ctx.exec` only makes its changes visible in the plan. Installing one (from GitHub, pinned to the cloned commit, npm dependencies with `--ignore-scripts`, off until enabled) is a decision to run that code.

- **Actions** (`host`, `environment` or `session` scope; `destructive` ones ask first): `devhost plugin run <plugin> <action> [--env|--session] [--dry-run] [--yes]`. The app shows them on the Plugins screen, in an environment's menu, and in a session's Open menu.
- **Checks:** shown by `doctor` as `plugin.<name>.<check>`.
- **Advice** on other checks (devhost's or another plugin's; `*` matches one id part; default on warn and fail): a note under that check with an optional fix and an action, a button in the app.
- **Widgets:** dashboard cards (`devhost plugin widgets [--param <plugin>.<filter>=<value>]…`): one card or several per widget, with status, summary, tiles, rows, a meter, a stacked-columns chart, a link as a QR code (`qr`: `url`, `label`; contract minor 2), an account color, a note and an action; `wide` cards span the page; `refreshSeconds` sets how often the app reloads them. **Filters** (segmented or select) appear above the plugin's cards; their values reach the widgets as `params`, and the app remembers them.
- **Sources:** built in (`src/plugins/builtin`, on unless `plugins.<name>.enabled: false`, cannot be uninstalled): `stats`, the dashboard's usage statistics. Installed from GitHub (`devhost plugin install <url|owner/repo>[#ref] [--name] [--enable]`: shallow clone into `~/.config/devhost/plugins/<name>`, npm dependencies with `--ignore-scripts`, source and commit recorded, off until enabled). `devhost plugin upgrade <name>` clones the recorded source again and swaps it in (configuration stays); `plugin list` shows `installedFrom.latestCommit` when the remote (`git ls-remote`, 8 s limit) is ahead, and the app's Plugins screen then offers Upgrade, or local (`~/.config/devhost/plugins/<name>/index.js`, only with `enabled: true`). `plugins.<name>.options` is `ctx.options`.
- Known external plugins: `devhost-plugin-disk-cleanup` (caches and old worktrees; a doctor check, advice under the disk check, a dashboard card) and `devhost-plugin-session-stop`.

---

# Part B — devhost Desktop (v2)

## B1. Purpose

A macOS app on the MacBook to configure and control the Mac mini, create environments, and see one dashboard across all Claude accounts and environments. It replaces typing `devhost` commands over SSH; it does not replace the Claude app for talking to sessions.

## B2. Architecture

- **Stack:** Tauri v2 (Rust shell) + TypeScript/React UI, in `packages/app`. Reason: the UI shares the generated types from `packages/contract` with the CLI, so config forms, command results, and dashboard data are typed end to end.
- **Architecture:** universal binary (`universal-apple-darwin`: Apple Silicon and Intel).
  - The app relies only on tools present on any Mac (system `ssh`, `open`, Terminal). Optional integrations (VS Code `code` CLI, iTerm, Safari web apps per account) are detected at runtime and hidden if missing.
  - **Minimum macOS: 26.0 (Tahoe).** Do not use APIs newer than macOS 26 without an availability check.
- **Transport:** the system `ssh` binary, using the user's `~/.ssh/config`, agent, and keys, over Tailscale (MagicDNS host name). Persistent connection via `ControlMaster`/`ControlPersist` for low latency. Every operation is `ssh <host> devhost <command> --json`; long-running ones read the NDJSON stream and write prompt answers to stdin (A9). The webview may only ask for `devhost <known subcommand>`, a few fixed Terminal actions, and http(s) URLs.
- **No server component on the Mac mini** beyond Part A. No ports opened beyond SSH.
- **Compatibility:** on connect, `devhost version --json`; refuse incompatible `contractVersion` majors with a clear message.
- **Naming:** the app never says "Mac mini". It names the machine by what `devhost version --json` reports (`host.name`: the configured `machine.hostname`, else the system host name), and says "the host" before it knows.
- **Storage in the app:** host name and UI preferences only (theme, dashboard plugin filters, which web app is which account's). No Claude credentials, no SSH keys, no telemetry copies, never the storage passphrase.
- Single host in v2; the data model allows a list of hosts later.
- A demo transport (sample data, scripted event streams) runs the UI in a plain browser for development and screenshots; never used inside the app.

## B3. Screens

### B3.1 Dashboard (home)

One view across all accounts and environments, from `devhost dash --follow --json` and `devhost plugin widgets --json`:

- **Header:** the host's health, titled with its name (online, uptime, CPU, RAM, internal disk free, Docker, Tailscale), with a work volume its state (mounted, free space, encrypted), Claude Code's version (current, a newer one with why the automatic update waits, the last update's outcome, outdated packages, and "Update now…": confirm → `devhost update`; when sessions are busy, "Interrupt them and update" runs it with `--force`), collector status, alert badges.
- **Plugin cards:** each enabled plugin's filters and cards (A18). The usage statistics are the built-in `stats` plugin's: filters (time range 1h / 24h / 7d / 30d, account, environment, model, tokens or cost, stacked by account or token type), a card per account (today / this week, login state, daily cost alert meter), tokens or estimated cost over time, and agents at work (now, most at once, over time). Charts have a table view.
- **Known limits** shown inline where relevant (A10.7).

Compact: tiles of the health header and of plugin cards flow at most 8 to a row; a card's `note`, a row's `note` and the comment on the Claude Code version sit behind an (i) tooltip; a card's `rows` flow in two columns where it is wide enough.

### B3.1.1 Sessions

Its own screen: the sessions open now (running, waiting for input, idle), all accounts together; ended ones are not listed. Columns: account, environment, session title (or last prompt) and id, subagents, state, started, last activity, tokens today, estimated cost today, CPU, RAM. Sort by any column. Sessions waiting for input are highlighted.

**Session actions:** open in claude.ai/code (the session itself for worktree sessions; through the account's web app when it has one), resume in Terminal, shell in the environment, open the environment in VS Code (`code --remote ssh-remote+<host> <path>`), open dev server URLs from the port block, plugin session actions, the session's handoff note (A10.10; written or shown, with a copy button). An ended session is reattached with `devhost session reattach` (A7.9), which the app no longer offers.

### B3.1.2 Monitor
A window of its own, opened from the menu bar (*Monitor*), to leave on a second monitor; the macOS full-screen button makes it fill the screen. Every idle or active session is a compact card, the ones waiting for input first, then the running ones, then the idle ones, the latest activity first within each. The cards are laid out to the window, so all of them are always on screen without scrolling: the more sessions, the smaller the cards. Each card shows:
- a lamp for the state: green and pulsing while running (steady under reduced motion), yellow while waiting, grey while idle;
- a prompt icon, and a highlighted border, while the session waits for input;
- its title, environment, last activity, context (warning over 300K), cost today, and running subagents;
- the QR code of its Remote Control session for a phone to open, whatever the *QR codes* setting; a local session has none.

A strip next to the host name shows: sessions waiting, running and idle, agents at work, estimated cost today and in the last hour, host CPU and memory, and alerts when there are any.

### B3.2 Environments

- Grouped by account (one card per account, in the config's order, with the account's color); status, CPU/RAM (process tree + its containers), port block, disk size, open sessions; ▶ opens the environment's Remote Control link; start / stop / restart; compose asleep (badge, with since when and what starts with the next session), put compose to sleep / wake compose (A7.9); logs; run setup again; plugin environment actions; delete.
- Estimated cost today per environment, flagged when over its daily or hourly limit; "…" → *Cost alerts…* sets both (A10.5), written to the config at once.
- **QR codes** (a toggle on Environments and Sessions, remembered as a UI preference, off by default): a code of each environment's Remote Control link, and on Sessions of each Remote Control session's claude.ai/code link, so a phone can open it off the screen (e.g. the app on a second monitor); a click, or "…" → *QR code for the phone*, shows a large one with the link. Dark on white in both themes. Sessions without a Remote Control link show none.
- With a work volume: its status (mounted, free space, encrypted) above the list; environments whose volume is missing are marked.
- **Create wizard:** account → name → repo URL (or empty) → Remote Control on/off, permission mode → compose auto/off → review (shows allocated port block and generated paths) → run `devhost env create --json` with a live step log. Prompt events (e.g. workspace trust) are handled in-app; a failed setup can be tried again.
- **Delete:** shows unpushed commits/branches from the CLI; typed-name confirmation; files kept unless explicitly chosen.

### B3.3 Accounts

- List of all accounts (any number): default flag, login state and login (email), credential store, last auth check, port range, environment count, web app.
- **New account wizard:** name → git name/email → default or not (disabled if a default exists) → optional daily cost alert → review (shows config dir, root, allocated port range) → `devhost account add --json` with live steps, continuing straight into the login flow below.
- **Remove:** disabled while the account has environments (lists them); otherwise runs `devhost account remove`, with an optional logout checkbox. States clearly that projects and credentials stay on disk.
- **Re-login flow:** runs `devhost login <account> --json`; on the `open-url` prompt, opens the URL in the MacBook browser (suggesting a private window when another account's login may be signed in); asks the user for the code and sends it back; shows the remaining human steps. A refused login (another account's or an unexpected login) says why and how to switch on purpose.
- **Web app per account:** a Safari web app (`Claude – <account>`) with its own cookies, so several claude.ai logins can be open at once.

### B3.4 Configuration

- Form editor generated from the config JSON Schema, plus a raw YAML tab with live validation.
- **Apply flow:** save → `devhost apply --dry-run --json` → show the plan as a diff (what changes, which steps need sudo) → confirm → `devhost apply --json` with live progress. Steps needing sudo show a notice that the password is entered in a Terminal window opened by the app (the app never handles the sudo password); with the root helper they need none.

### B3.5 Doctor and Logs

Two screens:
- **Doctor:** `devhost doctor --json` as a checklist with fix hints (a newer Claude Code has "Update now…", the same flow as on the dashboard), problems only by default ("All checks" shows the OK ones too), grouped by the first part of the check id, groups and checks in alphabetical order; copy-to-clipboard for fix commands; plugin advice under its check, with its action as a button.
- **Logs:** the collector and every Remote Control service, grouped by account, on the left; the selected log on the right, following every 3 s.

### B3.6 Menu bar

- Status dot (green / yellow / red from health and alerts), count of sessions waiting for input, quick links: Dashboard, Environments, Monitor (B3.1.2), Open claude.ai/code.

### B3.7 Plugins

- Installed and built-in plugins: version, source and commit, on/off, actions; install from GitHub, enable / disable, uninstall (not built-in ones); host actions with a preview (dry run) for those that remove things.

### B3.8 Storage

- Shown when a work volume is configured or external disks exist: status (mounted, uuid and marker match, encryption, ownership, free space, Spotlight).
- **Adopt** an existing APFS volume (`devhost storage adopt`), with the identity it will record.
- **Migrate** an account (`devhost storage migrate --account <a> --json`): shows the plan (services stopped, data copied, config and generated files updated, trust re-run, the history caveat) and asks for confirmation; live steps and prompts; `--cleanup` separately, with its own confirmation.
- **No `prepare` in the app**: erasing a disk is CLI only.
- The passphrase is never asked for or shown in the app.

## B4. Non-goals (v2)

- Chatting with or steering sessions (the Claude app and claude.ai/code do this).
- Code signing, notarization, distribution; personal local builds only.
- Windows/Linux clients; multiple hosts in the UI.
- Its own notification channel (ntfy and Claude push already cover this).
- Erasing or partitioning disks.

## B5. Safety

- Destructive actions (env delete, uninstall, apply with sudo steps, plugin actions that remove things, storage migrate cleanup) always show the CLI's plan first and require explicit confirmation.
- The app passes no secrets on command lines; prompt answers go through stdin.
- If the SSH connection drops mid-operation, the app shows the last known step and offers to re-check with `doctor`; Part A guarantees re-runs are safe.

## B6. Acceptance criteria (Part B)

1. On a MacBook with SSH access to the Mac mini over Tailscale, the app connects and shows the dashboard within 5 seconds. Verified on an Apple Silicon Mac running macOS 26.
2. The Sessions screen shows open sessions from all accounts together, with live CPU/RAM and today's tokens and estimated cost, matching `devhost dash --json`.
3. Creating an environment from the wizard produces the same result as `devhost env create`, and its session appears in the Claude app.
4. Adding a new account from the app (including login) and removing it works end to end, with the same result as the CLI; re-login of an existing account works, including the browser step.
5. Editing config in the form, reviewing the dry-run diff, and applying works; invalid config cannot be saved.
6. With the host offline, the app shows it (by name) as unreachable and recovers automatically when it returns.
9. No screen or message of the app says "Mac mini"; the host is named as `devhost version` reports it.
7. Plugin cards and filters on the dashboard match `devhost plugin widgets --json`; turning the `stats` plugin off removes the statistics.
8. With a work volume: its state shows in the header and on the Environments screen; adopt and migrate work from the Storage panel; the app offers no way to erase a disk.

## B7. Delivery phases (Part B)

1. App shell, SSH transport with ControlMaster, version check, status, doctor, environment list with start/stop/logs, menu bar. *(done)*
2. Dashboard: live stream, sessions table, environments panel, usage charts, per-account totals, session actions. *(done; statistics now from the `stats` plugin)*
3. Account add/remove wizard, environment create/delete wizard, account re-login flow, configuration editor with dry-run diff and apply. *(done)*
4. Plugins screen, plugin widgets and advice, session reattach, environments grouped by account. *(done)*
5. Work volume: header and Environments status, Storage panel (adopt, migrate). *(done, with Part A phase 7)*

Stop after each phase for review.
