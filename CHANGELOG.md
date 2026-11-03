# Changelog

## Unreleased

### Fixed
- `storage.unlock` compares the unlock service's volume UUID with the configured one, and removes the service when no encrypted volume is configured.
- `apply` and `uninstall` find orphaned `com.devhost.*` services (removed environments, Colima after a runtime switch); `apply` asks before removing them.
- The root helper's `set-passphrase`, `remove-passphrase` and `unlock-daemon-remove` need the sudo password; the sudoers rule resets the environment.
- Account roots must be absolute or start with `~/`; `storage adopt --root` resolves the path before checking it.
- Long runs (progress, interactive) have no default timeout; a timeout kills the whole process group; a failed `storage migrate` restarts the stopped services.
- `account remove` asks for confirmation unless `--yes`; `env logs --follow` tracks bytes and `--lines` is validated.
- A command interrupted by SIGINT is reported as cancelled (exit 130).

### Added
- `devhost version` reports the git commit when the build knows it.
- Dependabot for npm, cargo and GitHub Actions.
