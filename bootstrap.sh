#!/bin/bash
# devhost bootstrap: from a fresh macOS install to a configured Mac mini
# (Apple Silicon or Intel).
#
# Needs only the built-in shell. Installs Xcode Command Line Tools, Homebrew
# and Node 24 (with nvm when it is installed, else Homebrew), builds the devhost
# CLI from this checkout, installs it as `devhost`, then runs `devhost init`
# (if there is no config yet) and `devhost apply`.
#
# Usage: ./bootstrap.sh [--no-apply]
#   DEVHOST_NODE_VERSION=26 ./bootstrap.sh   another Node major
#
# Safe to re-run: every step checks first and skips what is already done.
set -euo pipefail

NODE_VERSION="${DEVHOST_NODE_VERSION:-24}"
NODE_FORMULA="${DEVHOST_NODE_FORMULA:-node@${NODE_VERSION}}"
NVM_DIR="${NVM_DIR:-${HOME}/.nvm}"
# Absolute path of the node devhost runs with (set by install_node).
NODE_BIN=""
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${HOME}/.config/devhost/config.yaml"
RUN_APPLY=1

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "${arg}" in
    --no-apply) RUN_APPLY=0 ;;
    -h | --help)
      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# nvm's Node comes prebuilt from nodejs.org, so Intel Macs skip a Homebrew source build.
install_node_nvm() {
  log "Installing Node ${NODE_VERSION} with nvm (${NVM_DIR})"
  # nvm is not written for `set -eu`. `nvm install` also upgrades to the newest ${NODE_VERSION}.x;
  # the nvm default alias is left alone.
  set +eu
  # shellcheck disable=SC1091
  . "${NVM_DIR}/nvm.sh" --no-use
  nvm install "${NODE_VERSION}"
  NODE_BIN="$(nvm which "${NODE_VERSION}")"
  set -eu
}

install_node_brew() {
  if brew list --formula "${NODE_FORMULA}" >/dev/null 2>&1; then
    echo "${NODE_FORMULA}: already installed."
  else
    log "Installing ${NODE_FORMULA}"
    brew install "${NODE_FORMULA}"
  fi
  # Versioned formulae are keg-only; link it so `node` is on PATH for ssh and launchd too.
  brew link --overwrite --force "${NODE_FORMULA}" >/dev/null
  # The opt/ path survives patch upgrades.
  NODE_BIN="${BREW_PREFIX}/opt/${NODE_FORMULA}/bin/node"
}

install_node() {
  if [ -s "${NVM_DIR}/nvm.sh" ]; then
    install_node_nvm
  else
    install_node_brew
  fi
  [ -x "${NODE_BIN}" ] || die "Node ${NODE_VERSION} is missing after installation (expected ${NODE_BIN:-a path})."
  # npm and the build below use this Node too.
  PATH="$(dirname "${NODE_BIN}"):${PATH}"
  export PATH
  echo "Node: ${NODE_BIN} ($("${NODE_BIN}" --version))"
}

# POSIX single quotes for the generated wrapper.
sh_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

build_devhost() {
  log "Building devhost"
  cd "${REPO_DIR}"
  npm ci
  npm run build
  # A wrapper, not a symlink to cli.js: ssh and launchd have a minimal PATH that never contains
  # an nvm Node, so the shebang's `env node` would not find it. Remove first: older versions
  # installed a symlink, and writing through it would overwrite cli.js.
  local target="${BREW_PREFIX}/bin/devhost"
  rm -f "${target}"
  {
    echo '#!/bin/sh'
    echo '# Generated by devhost bootstrap.sh: runs the CLI with the Node it was built with.'
    echo "exec $(sh_quote "${NODE_BIN}") $(sh_quote "${REPO_DIR}/packages/cli/dist/cli.js") \"\$@\""
  } >"${target}"
  chmod 755 "${target}"
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
