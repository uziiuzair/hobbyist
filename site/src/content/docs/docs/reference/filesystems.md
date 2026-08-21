---
title: Filesystem requirements
description: Reflinks, what needs them, and what happens on ext4, which is what most cheap VPS providers give you.
sidebar:
  order: 5
---

<p class="state state--starting">works everywhere, cheaply on some</p>

Hobbyist runs on any filesystem. On a **reflink-capable** one, copying a project
is nearly free. On the rest it is a real copy, which is correct and slow and
costs full disk space.

## Which is which

| Filesystem | Reflinks | Notes |
|---|---|---|
| **XFS** with `reflink=1` | yes | The default on modern `mkfs.xfs`. The usual recommendation on Linux |
| **ZFS** | yes | Also gives you snapshots of its own |
| **APFS** | yes | macOS. Nothing to configure |
| **Btrfs** | yes | |
| **ext4** | **no** | **The default image on a lot of cheap VPS providers** |

Check what you have:

```sh
df -T ~/.hobby            # Linux
mount | grep " / "        # macOS
```

`hobby init` also reports it, and warns rather than failing when reflinks are
absent.

## What needs them

| Feature | Without reflinks |
|---|---|
| [Snapshots](/docs/guides/snapshots/) | A full copy: slow, and full disk cost. Also [not reachable yet](/docs/status/#not-reachable) |
| Copy-on-write branching, Phase 1.5 | The same. [Not built yet](/docs/status/#not-built) |
| Everything else | Unaffected |

Day to day, running databases and apps and workers, this makes no difference at
all. It matters when you copy a project.

## The ext4 problem, stated plainly

ext4 is the default root filesystem on a lot of the cheap VPS providers this
project is aimed at, and it has no reflink support at any version. This is not
something a configuration flag fixes.

If cheap copies matter to you and you are provisioning a new box, choose XFS at
install time, or attach a second volume formatted XFS or ZFS and point
`$HOBBY_HOME` at it:

```sh
export HOBBY_HOME=/mnt/fast/hobby
```

That is the supported way to keep state on a different disk, and it is the one
change that turns a cheap VPS into a machine where copies are free.

## Postgres 18, and why the floor is lower than it looks

Cloning a **stopped** data directory is version independent. Cloning one that is
**awake** needs Postgres 18 or newer.

Because everything here hibernates, most instances are stopped most of the time,
so the version requirement applies far less often than it first appears. That
claim was worth checking rather than assuming, and the research is filed at
`docs/branching/research/2026-08-07-cloning-a-stopped-data-directory.md`.
