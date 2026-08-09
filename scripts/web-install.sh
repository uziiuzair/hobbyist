#!/usr/bin/env bash
#
# This is what gets served at https://hobby.sh/install.
#
#   curl -fsSL https://hobby.sh/install | bash
#
# It does as little as it possibly can: check for git, clone the repository,
# and hand over to the install.sh inside it. Everything real lives there, so
# what this file does and what `git clone && ./install.sh` does are the same
# install, and a reader who does not want to pipe a URL into a shell loses
# nothing by cloning instead.
#
# Keeping it small is the point rather than a style preference. This is the one
# file people are asked to trust sight unseen, so it should be short enough to
# read in full in the time it takes to decide.
#
# Deploying: this file is the artifact. Serve it verbatim at hobby.sh/install
# as text/plain. It is in the repository so the served copy has a source of
# truth and a history, and so changes to it are reviewed like any other change.

set -euo pipefail

REPO_URL="${HOBBY_REPO_URL:-https://github.com/uziiuzair/hobbyist.git}"
REPO_REF="${HOBBY_REPO_REF:-main}"
SRC_DIR="${HOBBY_SRC_DIR:-$HOME/.hobby/src}"

if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; RED="$(printf '\033[31m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; RED=""; RESET=""
fi

die() {
  printf '\n%serror:%s %s\n' "$RED" "$RESET" "$1" >&2
  if [ $# -gt 1 ]; then printf '\n%s\n' "$2" >&2; fi
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is not installed." \
  "Install git and run this again:

  Debian/Ubuntu:  sudo apt install git
  Fedora/RHEL:    sudo dnf install git
  macOS:          xcode-select --install"

if [ -d "$SRC_DIR/.git" ]; then
  # Already installed: this is an upgrade. Fetch and hard-reset rather than
  # pull, because a merge conflict in a directory the user never edits on
  # purpose is a dead end they did not ask to be in.
  printf '%s==>%s Updating %s\n' "$BOLD" "$RESET" "$SRC_DIR"
  git -C "$SRC_DIR" fetch --quiet origin "$REPO_REF" || die "could not fetch from $REPO_URL."
  git -C "$SRC_DIR" reset --quiet --hard "origin/$REPO_REF" || die "could not update $SRC_DIR."
else
  [ -e "$SRC_DIR" ] && die "$SRC_DIR exists and is not a git checkout." \
    "Move it aside, or set HOBBY_SRC_DIR to install somewhere else."
  printf '%s==>%s Cloning into %s\n' "$BOLD" "$RESET" "$SRC_DIR"
  mkdir -p "$(dirname "$SRC_DIR")"
  git clone --quiet --branch "$REPO_REF" "$REPO_URL" "$SRC_DIR" \
    || die "could not clone $REPO_URL." "Check the network and try again."
fi

[ -x "$SRC_DIR/install.sh" ] || die "$SRC_DIR/install.sh is missing or not executable." \
  "This should not happen with a clean clone. Remove $SRC_DIR and try again."

# exec, not call: the installer becomes this process, so its exit status is the
# one the user's shell sees and nothing here can swallow a failure.
exec "$SRC_DIR/install.sh"
