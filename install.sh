#!/usr/bin/env bash
#
# Installs the checkout it lives in.
#
# This half does the work: prerequisites, runtime, build, launcher, preflight.
# The one-liner at https://hobby.sh/install is a smaller script whose only job
# is to clone this repository and run this file, so the two stay separable: a
# manual `git clone && ./install.sh` is the same install, and nothing here
# assumes it was reached through curl.
#
# Re-running is safe and is how you upgrade: every step either replaces what it
# made last time or is a no-op.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN_MIN="1.1.0"

# Colour only when a human is looking at a terminal. Piped into a file or a
# log, escape codes are noise.
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()   { printf '    %s%s%s\n' "$GREEN" "$1" "$RESET"; }

# Every failure exits here, so every failure gets a reason and a next action.
# An installer that stops with a bare non-zero status has told the user
# nothing, and they are usually on a fresh box with no idea what it wanted.
die() {
  printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2
  if [ $# -gt 1 ]; then printf '\n%s\n' "$2" >&2; fi
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------

step "Checking this box"

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "hobby runs on Linux and macOS, and this is $(uname -s)." \
         "One box, one daemon, docker underneath. There is no Windows path today." ;;
esac

have git || die "git is not installed." "Install git and run this again."

# bun's installer unpacks a zip and refuses without this. A fresh Ubuntu cloud
# image does not ship it, which is how a five dollar VPS fails at the bun step
# with a message this script used to throw away.
have unzip || die "unzip is not installed." \
  "bun's installer needs it to unpack the release.

  Debian or Ubuntu:  sudo apt-get install -y unzip
  Fedora or RHEL:    sudo dnf install -y unzip
  macOS:             already present"

# Docker is not optional and not deferrable: every resource hobby manages is a
# container, so an install that "succeeds" without it produces a daemon that
# cannot do the one thing it exists for.
have docker || die "docker is not installed." \
  "hobby runs every database as a container, so docker is required.

  Linux:  curl -fsSL https://get.docker.com | sh
  macOS:  https://orbstack.dev or https://docker.com/products/docker-desktop"

if ! docker info >/dev/null 2>&1; then
  die "docker is installed but not reachable." \
    "Start it, or add yourself to the docker group and log back in:

  sudo systemctl start docker
  sudo usermod -aG docker \"\$USER\"   # then log out and back in"
fi
ok "docker is running"

# The TypeScript build is the memory-hungry step, and on a small box the kernel
# kills it rather than letting it fail with an error of its own.
#
# Measured 2026-08-22, one core, no swap: killed at 512MB twice, completed at
# 512MB once, completed at 640MB, and at 320MB it does not fail at all, it
# thrashes for over ten minutes. So this is a warning and not a refusal: the
# boundary is real but it is soft, and blocking an install that would have
# worked is worse than letting a slow one proceed. build_step below catches the
# kill itself and explains it.
MIN_TOTAL_MB=640
total_memory_mb() {
  case "$(uname -s)" in
    Linux)
      awk '/^MemTotal:|^SwapTotal:/ { total += $2 } END { printf "%d", total / 1024 }' /proc/meminfo
      ;;
    # macOS swaps dynamically and has no meaningful floor here.
    *) echo 999999 ;;
  esac
}

TOTAL_MB="$(total_memory_mb 2>/dev/null || echo 999999)"
if [ "$TOTAL_MB" -lt "$MIN_TOTAL_MB" ]; then
  printf '\n%swarning:%s this box has %sMB of memory and swap together.%s\n' "$BOLD" "$RESET" "$TOTAL_MB" ""
  cat >&2 <<EOF
    The build needs roughly ${MIN_TOTAL_MB}MB. Below that it may be killed by the
    kernel, or get very slow, and neither failure explains itself.

    Adding swap is the usual fix on a small VPS, and it is enough:

      sudo fallocate -l 2G /swapfile
      sudo chmod 600 /swapfile
      sudo mkswap /swapfile
      sudo swapon /swapfile
      echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

    Continuing anyway. This may work.

EOF
fi

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

# ADR 0006: Bun is the runtime. Installed here rather than demanded, because
# its own installer is one unprivileged curl into ~/.bun and the alternative
# is telling someone on a bare VPS to go and set up a language toolchain
# before they can try this.
if have bun; then
  ok "bun $(bun --version) already installed"
else
  step "Installing bun"
  note "hobby runs on bun (ADR 0006). This installs it under ~/.bun and needs no root."
  # Captured rather than discarded. bun's installer explains itself well when
  # it fails ("unzip is required to install bun" is the common one on a fresh
  # cloud image), and throwing that away left the user with nothing to act on.
  BUN_LOG="$(mktemp)"
  if ! curl -fsSL https://bun.sh/install | bash >"$BUN_LOG" 2>&1; then
    printf '\n%s\n' "$(tail -n 15 "$BUN_LOG")" >&2
    rm -f "$BUN_LOG"
    die "installing bun failed." "bun's own output is above. Try it by hand and run this again:

    curl -fsSL https://bun.sh/install | bash"
  fi
  rm -f "$BUN_LOG"
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  have bun || die "bun installed but is not on PATH." "Expected it at $BUN_INSTALL/bin/bun."
  ok "bun $(bun --version) installed"
fi

# A too-old bun is a worse failure than no bun: it gets further and breaks
# somewhere less obvious.
BUN_VERSION="$(bun --version)"
if [ "$(printf '%s\n%s\n' "$BUN_MIN" "$BUN_VERSION" | sort -V | head -n1)" != "$BUN_MIN" ]; then
  die "bun $BUN_VERSION is older than the $BUN_MIN this needs." "Upgrade with: bun upgrade"
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

step "Building"
cd "$REPO_DIR"

# A step killed by the OOM killer dies on SIGKILL and prints nothing at all, so
# "the output above says why" is false at exactly the moment the user most
# needs it to be true. 137 is 128 + SIGKILL. The memory floor checked earlier
# should catch this first; this is the backstop for a box that cleared the
# floor and ran out anyway because something else on it grew while we built.
build_step() {
  local what="$1"; shift
  local rc=0
  # Run it, then read the status. NOT `if ! "$@"`: inside that branch $? is
  # the status of the negated pipeline, which is always 0, so the OOM check
  # below never fired. Caught by running a build against a 512MB cap.
  "$@" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" = 137 ]; then
      die "$what ran out of memory and was killed." \
        "The kernel stopped it, which is why there is no error above.

  Free some memory, or add swap:

    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
    sudo mkswap /swapfile && sudo swapon /swapfile

  Then run this again."
    fi
    die "$what failed." "The output above says why. Nothing has been installed yet."
  fi
}

build_step "bun install" bun install --silent
build_step "the typescript build" bun x tsc --build
build_step "the studio build" bash -c 'cd packages/studio && bun run --silent build >/dev/null'
ok "built"

# ---------------------------------------------------------------------------
# Launcher
# ---------------------------------------------------------------------------

# A generated shim rather than a symlink to bin/hobby.js, because that file
# carries a `#!/usr/bin/env node` shebang: symlinked and run directly it would
# be executed by node, which is not what was just built and tested against, and
# on a box with no node it would not run at all. The shim pins the runtime and
# the checkout explicitly, so `hobby` means this build no matter what is on
# PATH later.
step "Installing the hobby launcher"

if [ -w "/usr/local/bin" ] && [ "${HOBBY_BIN_DIR:-}" = "" ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="${HOBBY_BIN_DIR:-$HOME/.local/bin}"
fi
mkdir -p "$BIN_DIR"

BUN_BIN="$(command -v bun)"
cat > "$BIN_DIR/hobby" <<EOF
#!/usr/bin/env bash
# Generated by $REPO_DIR/install.sh. Re-running that regenerates this.
exec "$BUN_BIN" "$REPO_DIR/packages/cli/bin/hobby.js" "\$@"
EOF
chmod +x "$BIN_DIR/hobby"
ok "$BIN_DIR/hobby -> $REPO_DIR"

# Told, not silently assumed. A launcher installed somewhere not on PATH is
# indistinguishable from a failed install the first time `hobby` is typed.
PATH_WARNING=""
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) PATH_WARNING="$BIN_DIR is not on your PATH." ;;
esac

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

step "Preparing the host"
"$BIN_DIR/hobby" init || die "hobby init failed." "The output above says what it could not do."

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

printf '\n%shobby is installed.%s\n\n' "$BOLD" "$RESET"

if [ -n "$PATH_WARNING" ]; then
  printf '  %s%s%s\n' "$RED" "$PATH_WARNING" "$RESET"
  printf '  Add it, then open a new shell:\n\n'
  printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.%src\n\n' "$BIN_DIR" "$(basename "${SHELL:-bash}")"
fi

cat <<EOF
  Start the daemon, then make something:

    hobby daemon &
    hobby new blog

  The second command prints a connection string. Everything sleeps when
  nothing is using it and wakes when something connects, so you can walk
  away and come back.

  Leaving is one command too: ${DIM}hobby eject blog${RESET} hands you a
  docker-compose.yml and the data directory, and does not hold on.
EOF
