---
title: Snapshots and restore
description: Built, tested, and reachable from nothing. Read this before you assume you have backups.
sidebar:
  order: 10
---

<p class="state state--undeployed">not reachable: use pg_dump</p>

**You cannot take a snapshot today.** This page exists so that nobody infers a
backup story from the presence of snapshot code in the repository.

## What exists

`packages/cli/src/daemon/snapshots.ts` implements the whole thing:
`takeSnapshot`, `restore`, `listSnapshots`, `findSnapshot`, `deleteSnapshot`, a
manifest format with verification, and a `quiesce` and `resume` pair that stops
the right resources in the right order and restarts what it stopped even when a
later stop throws. It has tests.

## What does not exist

A caller. There is no `hobby snapshot` verb and no HTTP route, so every caller
of `takeSnapshot` today is a test. The daemon can do it and nothing asks it to.

This is the same shape of gap that `createCaddyManager` had for a while: written,
correct, and wired to nothing. It is listed here rather than quietly omitted
because "mark what is not real yet" is one of this project's working agreements,
and a reader must never execute an aspiration.

## Back up with pg_dump

```sh
pg_dump "$(hobby connect blog --json | jq -r .connectionString)" > blog-$(date +%F).sql
```

`pg_dump` is not a workaround here. The data directory is a plain `PGDATA` and
`pg_dump` working is one of the invariants the project holds itself to.
[Portability](/docs/concepts/portability/).

For a whole project including a worker's storage,
[`hobby eject`](/docs/guides/eject/) produces a runnable copy today.

## The design, for whoever wires it up

Whole-project snapshots, taken by quiescing every resource in the project and
cloning the tree, then resuming. No point in time recovery: it was cut
deliberately rather than deferred, on the grounds that PITR means WAL archiving,
retention policy and a restore path complex enough to need its own testing
discipline.
[ADR 0016](/docs/decisions/0016-project-snapshots-and-no-pitr/).

The clone uses `cloneTree` (`packages/core/src/copy.ts`), which is reflink-based
where the filesystem supports it and a real copy where it does not. That same
primitive is what Phase 1.5 branching needs, which is the argument for building
snapshots before branching rather than after.
[Filesystem requirements](/docs/reference/filesystems/).
