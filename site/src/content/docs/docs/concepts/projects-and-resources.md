---
title: Projects and resources
description: A project is a namespace holding typed resources. Four kinds exist, and adding a fifth is one interface and one line.
sidebar:
  order: 1
---

<p class="state state--running">the model</p>

A **project** is a namespace. It holds **resources**, each of which has a
**kind**. That is the whole model, and it is deliberately small: the shape is
what lets later work add capabilities without rewriting earlier ones.

```
project "blog"
  primary   postgres    a database
  site      app         a Dockerfile, served over HTTP
  api       worker      a Worker on workerd
  jobs      queue       messages, with api bound as consumer
```

## The four kinds

`packages/core/src/types.ts` defines `ResourceKind` as
`'postgres' | 'app' | 'worker' | 'queue'`.

| Kind | Holds | Wakes on |
|---|---|---|
| [`postgres`](/docs/guides/postgres/) | A plain Postgres data directory | An inbound connection |
| [`app`](/docs/guides/apps/) | Nothing. Stateless by design | An inbound HTTP request |
| [`worker`](/docs/guides/workers/) | A built bundle, KV/R2/D1 state, and Durable Object storage | An inbound HTTP request |
| [`queue`](/docs/guides/queues/) | Messages, in a sqlite file the daemon owns | A message arriving |

[Durable Objects](/docs/guides/durable-objects/) are a capability of `worker`,
not a fifth kind.

`app` is stateless on purpose. Volumes are Phase 3, which keeps volume lifecycle
out of the phase that was already the hardest.

## Targets

Most commands take a `<target>`:

- `blog` when the project holds exactly one resource.
- `blog/primary` otherwise.

The short form exists because the common case is one database in one project,
and making that case type a slash is the kind of friction the project exists to
remove.

## States

`ResourceState` is a small union, and the two that matter to a reader are
resting states rather than transitions:

| State | Resting | Means |
|---|---|---|
| `running` | yes | Up, and serving |
| `sleeping` | yes | Stopped. This is the product working, not a fault |
| `undeployed` | yes | The row exists, with an id and a hostname, and no code has been deployed to it |
| `creating`, `starting`, `stopping`, `destroying` | no | In transition |
| `failed` | yes | Something went wrong and was recorded rather than swallowed |

`undeployed` is the youngest of these and exists because creating a resource and
deploying code to it are two acts, not one. Before that split, the daemon
refused to write a resource row without a build source, which meant Studio and
MCP could not create an `app` at all, having no filesystem path to offer.
[ADR 0014](/docs/decisions/0014-resource-records-exist-before-code/).

## Where things live on disk

Everything is under `~/.hobby`, or `$HOBBY_HOME` if you set it.

```
~/.hobby/
  state.db                       the daemon's own record
  hobby.sock                     the unix socket the CLI and MCP talk to
  hobby.json                     not read by anything, see configuration
  projects/
    blog/
      primary/
        pgdata/18/docker         a plain PGDATA
      api/
        bundle/                  the built worker and its manifest
        state/                   KV, R2, D1, cache
        do/                      Durable Object sqlite files
      jobs/
        queue/messages.sqlite
```

An `app` has no directory of its own, because it holds nothing.

The nesting under `pgdata` is not decoration. Postgres 18's official image
refuses to start when a bind mount lands directly on what used to be `PGDATA`,
so the mount point is the postgres home directory and the entrypoint puts the
real data directory in a subdirectory named after the major version.
`resolvePgdataPath` in `packages/core/src/config.ts` is the one place that is
written down, and everything that needs the true on-disk path derives it from
there.

## Adding a kind

Implement `ResourceKindHandler` (`packages/core/src/kinds.ts`) and add one line
to `createDefaultKindRegistry`. Four kinds already exist to copy from. That
seam, rather than a plugin system, is what
[ADR 0007](/docs/decisions/0007-hobbyist-is-a-platform/) means when it says the
phases are additive rather than successive rewrites.
