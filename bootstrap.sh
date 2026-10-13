#!/bin/bash
# devhost bootstrap: from a fresh macOS install to a configured Mac mini
# (Apple Silicon or Intel).
#
# Needs only the built-in shell. Installs Xcode Command Line Tools, Homebrew
# and Node, builds the devhost CLI from this checkout, links it as `devhost`,
# then runs `devhost init` (if there is no config yet) and `devhost apply`.
#
# Usage: ./bootstrap.sh [--no-apply]
#
# Safe to re-run: every step checks first and skips what is already done.
set -euo pipefail

NODE_FORMULA="${DEVHOST_NODE_FORMULA:-node@22}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${HOME}/.config/devhost/config.yaml"
RUN_APPLY=1

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "${arg}" in
    --no-apply) RUN_APPLY=0 ;;
    -h | --help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: ${arg}" ;;
  esac
done

[ "$(uname -s)" = "Darwin" ] || die "devhost targets macOS only."
# Under Rosetta uname reports x86_64 on Apple Silicon; that would install the Intel Homebrew.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
  die "this shell runs under Rosetta; run it natively: arch -arm64 /bin/bash ./bootstrap.sh"
fi
case "$(uname -m)" in
  arm64) BREW_PREFIX="/opt/homebrew" ;;
  x86_64)
    BREW_PREFIX="/usr/local"
    echo "Intel Mac: Homebrew no longer ships bottles for Intel, so some packages may build from source (slow)."
    ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

install_command_line_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    echo "Xcode Command Line Tools: already installed."
    return
  fi
  log "Installing Xcode Command Line Tools (needs sudo; this can take several minutes)"
  # This marker file makes softwareupdate list the tools, which works over SSH
  # where the xcode-select GUI dialog cannot be shown.
  local marker="/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress"
  touch "${marker}"
  local label
  label="$(softwareupdate -l 2>/dev/null | sed -n 's/^\* Label: \(Command Line Tools.*\)$/\1/p' | sort -V | tail -n 1 || true)"
  if [ -n "${label}" ]; then
    sudo softwareupdate -i "${label}" --verbose
    rm -f "${marker}"
  else
    rm -f "${marker}"
    echo "Could not find the tools via softwareupdate; opening the macOS installer dialog."
    xcode-select --install || true
    until xcode-select -p >/dev/null 2>&1; do
      echo "Waiting for the Command Line Tools installer to finish..."
      sleep 15
    done
  fi
  xcode-select -p >/dev/null 2>&1 || die "Command Line Tools are still missing."
}

install_homebrew() {
  if [ -x "${BREW_PREFIX}/bin/brew" ]; then
    echo "Homebrew: already installed."
  else
    log "Installing Homebrew (needs sudo)"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  [ -x "${BREW_PREFIX}/bin/brew" ] || die "Homebrew is not at ${BREW_PREFIX}/bin/brew after installation."
  eval "$("${BREW_PREFIX}/bin/brew" shellenv)"
}

install_node() {
  if brew list --formula "${NODE_FORMULA}" >/dev/null 2>&1; then
    echo "${NODE_FORMULA}: already installed."
  else
    log "Installing ${NODE_FORMULA}"
    brew install "${NODE_FORMULA}"
  fi
  # Versioned formulae are keg-only; link it so `node` is on PATH for ssh and launchd too.
  brew link --overwrite --force "${NODE_FORMULA}" >/dev/null
  command -v node >/dev/null 2>&1 || die "node is not on PATH after installing ${NODE_FORMULA}."
}

build_devhost() {
  log "Building devhost"
  cd "${REPO_DIR}"
  npm ci
  npm run build
  chmod +x "${REPO_DIR}/packages/cli/dist/cli.js"
  ln -sf "${REPO_DIR}/packages/cli/dist/cli.js" "${BREW_PREFIX}/bin/devhost"
  devhost version
}

install_command_line_tools
install_homebrew
install_node
build_devhost

if [ ! -f "${CONFIG_FILE}" ]; then
  log "No config yet: running devhost init"
  devhost init
fi

if [ "${RUN_APPLY}" -eq 1 ]; then
  log "Previewing the changes (nothing is modified yet)"
  devhost apply --dry-run
  log "Applying"
  devhost apply
else
  log "Skipping apply (--no-apply). Review ${CONFIG_FILE}, then run: devhost apply --dry-run && devhost apply"
fi
