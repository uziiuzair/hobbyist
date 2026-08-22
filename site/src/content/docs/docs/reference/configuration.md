---
title: Configuration and paths
description: Every setting, where it is read from, and what lives where on disk.
sidebar:
  order: 2
---

<p class="state state--running">works</p>

## Resolution order

Config values come from, in decreasing priority:

1. Command-line flags.
2. `HOBBY_*` environment variables.
3. A `hobby.json` found by walking up from the current directory.
4. Defaults.

Paths are separate and simpler: they always come from `$HOBBY_HOME`, or
`~/.hobby` if that is unset.

:::caution[`~/.hobby/hobby.json` is not read]
`resolvePaths` constructs a `configPath` at `$HOBBY_HOME/hobby.json`
(`packages/core/src/config.ts:47`) and **nothing reads it**. Config comes only
from the cwd walk in step 3 above.

Two consequences worth knowing. Settings written to `~/.hobby/hobby.json` do
nothing and report no error, including `sleepAfterSeconds`. And because the walk
is relative to the working directory, the daemon's configuration depends on
which directory it was started from, and `hobby ls` run from two different
directories can resolve two different configs.

Start the daemon from the directory holding your `hobby.json`.
:::

## Settings

| Key | Env | Default | What |
|---|---|---|---|
| `image` | | `postgres:18-alpine` | The Postgres image |
| `proxyPort` | `HOBBY_PROXY_PORT` | `5432` | Where the wire-protocol proxy listens |
| `proxyHost` | `HOBBY_PROXY_HOST` | `127.0.0.1` | Which addresses it binds. An address, `"tailnet"`, or `"all"`. See below |
| `project` | | `null` | Which project this directory belongs to. Written by `hobby link` |
| `studioPort` | `HOBBY_STUDIO_PORT` | `8443` | **Nothing listens on this.** Studio is served by the daemon on `apiPort`. The value is only used by a preflight port check |
| `apiPort` | | `7432` | The daemon API, loopback only |
| `httpPort` | | `7433` | The HTTP wake router |
| `queuePort` | | `7434` | The queue endpoint |
| `domain` | | `localhost` | The base domain apps and workers get hostnames under |
| `sleepAfterSeconds` | | `300` | Idle time before a resource sleeps |
| `wakeTimeoutMs` | | `30000` | How long a wake may take before it is a failure |
| `readinessPollMs` | | `25` | How often readiness is polled during a wake |
| `caddyEnabled` | | `false` | Whether the Caddy front door runs at all |
| `caddyAdminPort` | | `2019` | Caddy's admin API, loopback only |
| `caddyStudioHost` | | `null` | The public hostname for Studio. `null` publishes no Studio route |

A minimal `hobby.json`:

```json
{
  "sleepAfterSeconds": 900,
  "caddyEnabled": true,
  "domain": "example.com"
}
```

## Reaching a database from another machine

`proxyHost` decides what the Postgres proxy binds, and it defaults to loopback.

| Value | Binds |
|---|---|
| `"127.0.0.1"` (default) | Loopback only. Nothing off the box can connect |
| `"tailnet"` | Loopback **and** this machine's Tailscale address |
| `"all"` | Every interface |
| any address | That address literally |

`"tailnet"` is the recommended setting for a box you want to reach from your
laptop. It binds loopback as well, because `hobby connect` builds its string
against `127.0.0.1` and would otherwise stop working on the box itself.

:::danger[`"all"` puts Postgres on the internet]
The proxy speaks no TLS. It answers an `SSLRequest` with `N`, so anything
connecting across a network sends its password in cleartext. On a cloud VM with
a public address and no firewall, `"all"` means anyone can reach your database.

Two boxes installed from `hobby.sh/install` were measured in exactly that state
on 2026-08-22, which is why the default changed.
[ADR 0017](/docs/decisions/0017-the-proxy-binds-loopback-by-default/).
:::

## Paths

```
~/.hobby/
  state.db                       the daemon's record of everything
  hobby.sock                     the unix socket for the CLI and MCP
  hobby.json                     NOT read. See the note below
  projects/
    <project>/
      <resource>/
        pgdata/18/docker         postgres: a plain PGDATA
        bundle/                  worker: the built script and its manifest
        state/                   worker: KV, R2, D1, cache
        do/                      worker: Durable Object sqlite
        queue/messages.sqlite    queue: the messages
```

An `app` has no directory: it is stateless by design.

`$HOBBY_HOME` moves all of it. That is the supported way to keep state on a
different disk.

### Why pgdata nests

Postgres 18's official image refuses to start when a bind mount lands directly
on what used to be `PGDATA`. The mount point is therefore the postgres home
directory, and the image's entrypoint places the real data directory in a
subdirectory named for the major version. `resolvePgdataPath` in
`packages/core/src/config.ts` is the one place that is written down; everything
needing the true on-disk path derives it from there rather than hardcoding the
subdirectory.

## Port allocation

Resources that need a directly reachable host port are allocated one from
**15000 to 19999**. That is the port `hobby ls` prints. It is not the port you
normally dial: for Postgres that is the proxy on 5432, which is what makes wake
work.

## Installer variables

Read by [the bootstrap script](/docs/install/#options), not by the daemon:

| Variable | Default | What |
|---|---|---|
| `HOBBY_SRC_DIR` | `~/.hobby/src` | Where the checkout lives |
| `HOBBY_REPO_REF` | `main` | Branch or tag to install |
| `HOBBY_REPO_URL` | the canonical repository | Where to clone from |
| `HOBBY_BIN_DIR` | `/usr/local/bin` or `~/.local/bin` | Where the launcher goes |
