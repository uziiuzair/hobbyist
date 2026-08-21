#!/usr/bin/env bash
#
# What https://hobby.sh/install serves.
#
#   curl -fsSL https://hobby.sh/install | bash
#
# This half does one thing: put a checkout on disk and hand off to that
# checkout's own install.sh, which is where every real step lives
# (prerequisites, runtime, build, launcher, preflight). Keeping the two
# separable is deliberate and is stated at the top of install.sh: a manual
# `git clone && ./install.sh` must be the identical install, and nothing in
# install.sh may assume it was reached through curl.
#
# It follows that this file must never grow a step of its own. If you find
# yourself adding a prerequisite check here that install.sh also does, the
# check belongs there and only there, or the two installs drift and the
# manual one becomes the untested path.
#
# Re-running is safe and is how you upgrade: an existing checkout is fetched
# and fast-forwarded rather than re-cloned, and install.sh's own steps each
# either replace what they made last time or are a no-op.
#
# Environment:
#   HOBBY_SRC   where the checkout lives.   default: ~/.hobby/src
#   HOBBY_REF   branch or tag to install.   default: main
#   HOBBY_REPO  where to clone from.        default: the canonical repository

set -euo pipefail

HOBBY_REPO="${HOBBY_REPO:-https://github.com/uziiuzair/hobbyist.git}"
HOBBY_REF="${HOBBY_REF:-main}"
HOBBY_SRC="${HOBBY_SRC:-$HOME/.hobby/src}"

# Colour only when a human is looking at a terminal. Piped into a file or a
# log, escape codes are noise. Same shape as install.sh so the two halves read
# as one program.
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"; RED="$(printf '\033[31m')"
  GREEN="$(printf '\033[32m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; RESET=""
fi

step() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
ok()   { printf '    %s%s%s\n' "$GREEN" "$1" "$RESET"; }

die() {
  printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2
  if [ $# -gt 1 ]; then printf '\n%s\n' "$2" >&2; fi
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# The two things needed to get a checkout, and nothing else
# ---------------------------------------------------------------------------

# Checked here rather than deferred to install.sh only because the failure is
# otherwise a git error about an unknown platform, which tells the reader
# nothing. The wording matches install.sh's so the two read as one product.
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "hobby runs on Linux and macOS, and this is $(uname -s)." \
         "One box, one daemon, docker underneath. There is no Windows path today." ;;
esac

have git || die "git is not installed." \
  "Install git and run this again.

  Debian or Ubuntu:  sudo apt-get install -y git
  macOS:             xcode-select --install"

# Piping into bash means stdin is the script, so anything install.sh wants to
# read from a human (it does not today, but hobby init may grow a prompt) would
# read the rest of this file instead. Reconnecting stdin to the terminal costs
# one line and removes a whole class of confusing failure.
#
# The open is probed in a subshell first rather than guarded with `[ -e
# /dev/tty ]`. /dev/tty exists as a path even in a process with no controlling
# terminal (a container build, a CI step, ssh without a tty), where opening it
# fails with ENXIO; a failed redirection on `exec` exits a non-interactive
# shell outright, and `|| true` does not save it, so the whole install would
# die at this line having done nothing. Probing costs a subshell and turns a
# hard exit into a skipped optimisation.
if [ ! -t 0 ] && ( : < /dev/tty ) 2>/dev/null; then
  exec < /dev/tty
fi

# ---------------------------------------------------------------------------
# Clone, or update in place
# ---------------------------------------------------------------------------

if [ -d "$HOBBY_SRC/.git" ]; then
  step "Updating the checkout at $HOBBY_SRC"

  # An existing checkout is only safe to fast-forward if it is actually this
  # project. Someone with an unrelated repository at ~/.hobby/src should get a
  # clear refusal, not a checkout across unrelated histories.
  ORIGIN_URL="$(git -C "$HOBBY_SRC" remote get-url origin 2>/dev/null || true)"
  case "$ORIGIN_URL" in
    *hobbyist*) ;;
    *) die "$HOBBY_SRC is a git checkout, but its origin is not hobbyist." \
         "origin is: ${ORIGIN_URL:-(none)}

  Refusing to touch it. Install somewhere else:

    HOBBY_SRC=~/somewhere-else bash <(curl -fsSL https://hobby.sh/install)" ;;
  esac

  # Local edits are the user's, not ours to discard. This is the one place a
  # re-run can lose work, so it refuses instead.
  if ! git -C "$HOBBY_SRC" diff --quiet || ! git -C "$HOBBY_SRC" diff --cached --quiet; then
    die "$HOBBY_SRC has uncommitted changes." \
      "Refusing to touch them. Commit or stash them and run this again, or point
  somewhere else:

    HOBBY_SRC=~/somewhere-else bash <(curl -fsSL https://hobby.sh/install)"
  fi

  git -C "$HOBBY_SRC" fetch --quiet origin "$HOBBY_REF" \
    || die "could not fetch $HOBBY_REF from origin." "Check the network, then run this again."
  git -C "$HOBBY_SRC" checkout --quiet FETCH_HEAD \
    || die "could not check out $HOBBY_REF." "The output above says why."
  ok "at $(git -C "$HOBBY_SRC" rev-parse --short HEAD)"
else
  # A non-empty directory that is not a checkout is almost always a mistake,
  # and cloning into it would fail with a less useful message than this one.
  if [ -e "$HOBBY_SRC" ] && [ -n "$(ls -A "$HOBBY_SRC" 2>/dev/null)" ]; then
    die "$HOBBY_SRC exists, is not empty, and is not a git checkout." \
      "Move it aside, or install somewhere else:

    HOBBY_SRC=~/somewhere-else bash <(curl -fsSL https://hobby.sh/install)"
  fi

  step "Cloning hobbyist into $HOBBY_SRC"
  note "$HOBBY_REPO at $HOBBY_REF"
  mkdir -p "$(dirname "$HOBBY_SRC")"
  git clone --quiet --depth 1 --branch "$HOBBY_REF" "$HOBBY_REPO" "$HOBBY_SRC" \
    || die "git clone failed." "The output above says why. Nothing has been installed yet."
  ok "cloned"
fi

# ---------------------------------------------------------------------------
# Hand off
# ---------------------------------------------------------------------------

[ -x "$HOBBY_SRC/install.sh" ] || die "$HOBBY_SRC/install.sh is missing or not executable." \
  "This should not happen with a clean checkout. Delete $HOBBY_SRC and try again."

exec "$HOBBY_SRC/install.sh"
