# Changelog

## Unreleased

### Added
- `devhost session start <env> --worktree <name>`: a new background session on Remote Control in a new worktree of the environment (account, ports and OTel attributes of the environment), prompt from `--prompt` or `--prompt-file` (`-` is stdin); returns its session id, job id, branch and claude.ai link.
- `devhost session list [--env] [--account]`: the open sessions and today's ended ones with state, `waitingFor` (permission / question), branch and claude.ai link, from the collector's database only.
- `env list --json`: `repo`, the environment's origin URL.
- Contract minor 4: `result.session-start`, `result.session-list`, `repo` in `result.env-list`.

### Fixed
- Sessions on Remote Control outside a service worktree (background sessions, a session in the environment folder) got no claude.ai link in `dash` and were ended after 10 minutes: the collector reads every live session process's session file (`bridgeSessionId`), and `dash` uses the recorded link.

## 1.0.0 (2026-11-05)

### Fixed
- `storage.unlock` compares the unlock service's volume UUID with the configured one, and removes the service when no encrypted volume is configured.
- `apply` and `uninstall` find orphaned `com.devhost.*` services (removed environments, Colima after a runtime switch); `apply` asks before removing them.
- The root helper's `set-passphrase`, `remove-passphrase` and `unlock-daemon-remove` need the sudo password; the sudoers rule resets the environment.
- Account roots must be absolute or start with `~/`; `storage adopt --root` resolves the path before checking it.
- Long runs (progress, interactive) have no default timeout; a timeout kills the whole process group; a failed `storage migrate` restarts the stopped services.
- `account remove` asks for confirmation unless `--yes`; `env logs --follow` tracks bytes and `--lines` is validated.
- A command interrupted by SIGINT is reported as cancelled (exit 130).

### Changed
- Toolchain: vitest 5, vite 8, @vitejs/plugin-react 6, eslint 10, TypeScript 6.0 (explicit `types`, no `baseUrl`). TypeScript 7 waits for typescript-eslint support.

### Added
- MIT license.
- README: a verification matrix (what CI and the fake Mac cover, what is still unverified on real hardware), notes on plugin trust, the public ntfy relay, the collector's checks, the `0.0.0.0` dev-server rule and contract versioning; missing `env create` / `uninstall` flags and the `agents`, `storage.*`, `services.orphans` step ids.
- `devhost version` reports the git commit when the build knows it.
- Dependabot for npm, cargo and GitHub Actions.
