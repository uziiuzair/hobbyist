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
| Filesystem | Anything works. XFS with reflinks, ZFS or APFS additionally get cheap copies. [Details](/docs/reference/filesystems/) |

On a fresh Debian or Ubuntu box, Docker first:

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"    # then log out and back in
```

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

## Upgrading

Run the same one-liner again. An existing checkout is fetched and reset to the
latest commit rather than re-cloned, which is why nothing you edit by hand
under `~/.hobby/src` survives an upgrade. It refuses outright if the directory
is a checkout of something other than this project.

## Uninstalling

There is no uninstall command, on purpose: everything it made is in two places
you can see.

```sh
hobby eject <project> --release   # for each project you want to keep
rm -rf ~/.hobby                   # state, config, and every data directory
sudo rm /usr/local/bin/hobby      # or ~/.local/bin/hobby
```

Eject first. `~/.hobby/projects/` holds the data directories, and removing it
removes your databases.

## Then

Start the daemon and make something:

```sh
hobby daemon &
hobby new blog
```

[Your first project](/docs/first-project/) walks through what that prints.
