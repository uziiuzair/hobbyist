---
title: Install
description: One command, what it does to your machine, and how to do the same thing by hand if you would rather read it first.
---

<p class="state state--running">works</p>

```sh
curl -fsSL https://hobby.sh/install | bash
```

Piping a script into a shell asks you to trust a URL. If you would rather not,
[read it first](https://github.com/uziiuzair/hobbyist/blob/main/scripts/web-install.sh) or
[do it by hand](#by-hand). Every path runs the identical installer, which is
deliberate and is stated at the top of the script itself. The same bytes are
also mirrored at `https://hobbyist.sh/install`.

## Requirements

| | |
|---|---|
| Operating system | Linux or macOS. Ubuntu and Debian are the tested Linux targets. There is no Windows path |
| Docker | Required, not optional. Every resource is a container |
| Bun 1.1+ | Installed for you under `~/.bun` if missing. Needs no root |
| git | Needed to fetch the checkout |
| curl | Needed to fetch Bun's installer. The install script checks for it (`install.sh`) |
| unzip | Needed by Bun's installer. **Absent from a fresh Ubuntu cloud image**, and the usual reason an install fails on a cheap VPS |
| psql | Optional. `hobby connect` opens it when it is on PATH and prints the connection string when it is not (`cmdConnect`, `packages/cli/src/cli/commands.ts`). Debian or Ubuntu: `postgresql-client`; macOS: `brew install libpq` |
| Memory | About 640MB of RAM and swap together, to build. See below |
| Filesystem | Anything works. XFS with reflinks, ZFS or APFS additionally get cheap copies. [Details](/docs/reference/filesystems/) |

On a fresh Debian or Ubuntu box, the prerequisites first:

```sh
sudo apt-get update && sudo apt-get install -y git curl unzip
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"    # then log out and back in
```

`unzip` matters more than it looks. Bun's installer needs it to unpack the
release, and Ubuntu's cloud images do not ship it, so without it the install
stops at the Bun step.

## If you are on a 512MB box

Add swap before installing. The TypeScript build is the memory-hungry step, and
below roughly 640MB the kernel kills it, which produces no error of its own.

```sh
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Measured on one core with no swap: killed at 512MB, completed at 640MB, and at
320MB it does not fail so much as thrash for over ten minutes. 512MB with swap
completes. A 1GB droplet is fine without swap.

On macOS, [OrbStack](https://orbstack.dev) is what the measurements were taken
on. Docker Desktop is expected to work for everything except Caddy, whose host
networking requirement is [unmeasured there](/docs/status/).

## What the installer does

In order, and each step either replaces what it made last time or is a no-op, so
re-running is how you upgrade:

1. **Checks the box.** Refuses anything that is not Linux or macOS. Requires
   `git`. Requires Docker to be installed *and reachable*, because an install
   that succeeds without it produces a daemon that cannot do the one thing it
   exists for.
2. **Installs Bun** under `~/.bun` if it is missing, using Bun's own installer.
   No root. A too-old Bun is rejected outright, because it gets further and then
   breaks somewhere less obvious.
3. **Builds** the workspace and the Studio bundle.
4. **Installs a launcher** at `/usr/local/bin/hobby` if that is writable, and
   `~/.local/bin/hobby` otherwise. It is a generated shim, not a symlink, so
   `hobby` always means this build regardless of what lands on `PATH` later. If
   the directory it chose is not on your `PATH`, it says so.
5. **Runs `hobby init`**, which prepares `~/.hobby` and checks the filesystem.

It does not install a service unit, open a firewall port, write to any system
directory other than the launcher, or start a daemon. Starting the daemon is
yours.

## By hand

```sh
git clone https://github.com/uziiuzair/hobbyist
cd hobbyist
./install.sh
```

This is the same install. The one-liner's only job is to put this checkout on
disk and run this file.

## Options

The bootstrap script reads three environment variables:

| Variable | Default | What |
|---|---|---|
| `HOBBY_SRC_DIR` | `~/.hobby/src` | Where the checkout lives |
| `HOBBY_REPO_REF` | `main` | The branch or tag to install |
| `HOBBY_REPO_URL` | the canonical repository | Where to clone from |

```sh
HOBBY_SRC_DIR=~/code/hobbyist bash <(curl -fsSL https://hobby.sh/install)
```

The installer itself reads `HOBBY_BIN_DIR` if you want the launcher somewhere
specific.

## Keeping the daemon running

`hobby daemon &` dies with the shell that started it, so on a box reached over
ssh the daemon stops when the connection drops. For a box meant to stay up,
run it as a service. The repository ships a systemd unit at
`scripts/hobby.service` (it waits for Docker, restarts on failure and gives the
daemon 90 seconds to stop cleanly):

```sh
sudo cp ~/.hobby/src/scripts/hobby.service /etc/systemd/system/hobby.service
sudo systemctl daemon-reload
sudo systemctl enable --now hobby
journalctl -u hobby -f          # the daemon logs every sleep, wake and failed wake
```

The unit runs as root because the Docker socket is root-owned on most
installs; to run as another user, add them to the `docker` group and change
`User=` in the unit. There is no launchd plist for macOS yet: a Mac that
should keep serving runs `hobby daemon` in a terminal or a `tmux` session.

## Upgrading

Run the same one-liner again, or `hobby update`. An existing checkout is
fetched and reset to the requested ref (a branch or a tag) rather than
re-cloned, which is why nothing you edit by hand under `~/.hobby/src` survives
an upgrade. It refuses outright if the directory is a checkout of something
other than this project.

The running daemon keeps the old code until it is restarted. After an upgrade:

```sh
sudo systemctl restart hobby    # under systemd
# or: stop the `hobby daemon` you started by hand and start it again
```

## Uninstalling

There is no uninstall command, on purpose: everything it made is in two places
you can see.

```sh
hobby eject <project> --release   # for each project you want to keep
hobby rm <project> --yes          # for each project you do not: removes its containers, network and images
# stop the daemon (systemctl stop hobby, or end `hobby daemon`)
docker ps -a --filter name=hobby- -q | xargs -r docker rm -f     # anything hobby rm did not reach
docker network ls --filter name=hobby- -q | xargs -r docker network rm
docker images 'hobby/*' -q | xargs -r docker rmi
rm -f /tmp/hobby-daemon.lock
rm -rf ~/.hobby                   # state, config, and every data directory
sudo rm /usr/local/bin/hobby      # or ~/.local/bin/hobby
sudo rm /etc/systemd/system/hobby.service && sudo systemctl daemon-reload   # if you installed the unit
```

Eject first. `~/.hobby/projects/` holds the data directories, and removing it
removes your databases. The containers (`hobby-<project>-<resource>`), the
per-project networks (`hobby-<project>`) and the built images (`hobby/*`) are
Docker's, not files under `~/.hobby`, which is why they need their own lines.

## Then

Start the daemon and make something:

```sh
hobby daemon &
hobby new blog
```

[Your first project](/docs/first-project/) walks through what that prints.
