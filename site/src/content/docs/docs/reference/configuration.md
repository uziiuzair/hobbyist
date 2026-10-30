---
title: Configuration and paths
description: Every setting, where it is read from, and what lives where on disk.
sidebar:
  order: 2
---

<p class="state state--running">works</p>

## Resolution order

Config values come from, in decreasing priority:

1. `HOBBY_*` environment variables (`readEnvConfig`,
   `packages/core/src/config.ts`).
2. A `hobby.json` found by walking up from the current directory
   (`findConfigFile`, the same file).
3. Defaults (`DEFAULT_CONFIG`, the same file).

There are no command-line flags for configuration. `resolveConfig` accepts a
`flags` argument, and the one caller, `packages/cli/src/cli/main.ts`, passes
`{ env, cwd }` and nothing else. The flags that do exist on verbs
(`--sleep-after`, `--port`, `--pin`) change one project or one resource, never
the daemon's config.

Paths are separate and simpler: they always come from `$HOBBY_HOME`, or
`~/.hobby` if that is unset.

:::caution[`~/.hobby/hobby.json` is not read]
`resolvePaths` constructs a `configPath` at `$HOBBY_HOME/hobby.json`
(`packages/core/src/config.ts:47`) and **nothing reads it**. Config comes only
from the cwd walk in step 2 above.

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
| `image` | `HOBBY_IMAGE` | `postgres:18-alpine` | The Postgres image |
| `proxyPort` | `HOBBY_PROXY_PORT` | `5432` | Where the wire-protocol proxy listens |
| `proxyHost` | `HOBBY_PROXY_HOST` | `127.0.0.1` | Which addresses it binds. An address, `"tailnet"`, or `"all"`. See below |
| `proxyTls` | `HOBBY_PROXY_TLS_CERT`, `HOBBY_PROXY_TLS_KEY`, `HOBBY_PROXY_TLS_HOSTNAME` | `null` | TLS for the proxy: `{ certFile, keyFile, hostname }`. See below |
| `project` | | `null` | Which project this directory belongs to. Written by `hobby link` |
| `studioPort` | `HOBBY_STUDIO_PORT` | `8443` | **Nothing listens on this.** Studio is served by the daemon on `apiPort`. The value is only used by a preflight port check |
| `apiPort` | `HOBBY_API_PORT` | `7432` | The daemon API, loopback only. Gated by the operator session or an API token; see [the API reference](/docs/reference/api/#listeners-and-what-authenticates) |
| `httpPort` | `HOBBY_HTTP_PORT` | `7433` | The HTTP wake router |
| `queuePort` | `HOBBY_QUEUE_PORT` | `7434` | The queue endpoint |
| `domain` | `HOBBY_DOMAIN` | `localhost` | The base domain apps and workers get hostnames under |
| `sleepAfterSeconds` | `HOBBY_SLEEP_AFTER_SECONDS` | `300` | The idle threshold a **new** project is given. See below: it is copied at creation, not read live |
| `wakeTimeoutMs` | `HOBBY_WAKE_TIMEOUT_MS` | `30000` | How long a wake may take before it is a failure |
| `readinessPollMs` | `HOBBY_READINESS_POLL_MS` | `25` | How often readiness is polled during a wake |
| `caddyEnabled` | `HOBBY_CADDY_ENABLED` | `false` | Whether the Caddy front door runs at all. Only `1` or `true` turns it on; anything else is false |
| `caddyAdminPort` | `HOBBY_CADDY_ADMIN_PORT` | `2019` | Caddy's admin API, loopback only |
| `caddyStudioHost` | `HOBBY_CADDY_STUDIO_HOST` | `null` | The public hostname for Studio. `null` publishes no Studio route |

Every numeric variable is validated by name (`envInteger`): a value that is
not a whole number in range stops the daemon with a message naming the
variable, rather than becoming `NaN` somewhere downstream.

### `sleepAfterSeconds` is a default for new projects

The hibernator reads each project's own threshold and nothing else
(`project?.sleepAfterSeconds`, `packages/cli/src/daemon/hibernator.ts`). The
box-wide value is copied into the project row once, when the project is
created (`createProjectRoute`, `packages/cli/src/daemon/routes.ts`, which
falls back to `ctx.config.sleepAfterSeconds` when the request names no
threshold). Three consequences:

- Changing `HOBBY_SLEEP_AFTER_SECONDS` or `hobby.json` and restarting the
  daemon changes nothing for projects that already exist. They keep the value
  they were born with, and `hobby ls --json` shows it.
- To change an existing project, use `hobby unpin <project> --sleep-after <seconds>`,
  which writes the project's own threshold over `POST /v1/projects/{name}/sleep-policy`.
  `hobby pin` sets it to `null`, which means never.
- `HOBBY_SLEEP_AFTER_SECONDS=null` is accepted and means every project created
  from then on is born pinned. Any other non-number is refused.

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

:::danger[`"all"` without `proxyTls` puts Postgres on the internet]
Without `proxyTls`, the proxy speaks no TLS. It answers an `SSLRequest` with
`N`, so anything connecting across a network sends its password in cleartext. On a cloud VM with
a public address and no firewall, `"all"` means anyone can reach your database.

Two boxes installed from `hobby.sh/install` were measured in exactly that state
on 2026-08-22, which is why the default changed.
[ADR 0017](/docs/decisions/0017-the-proxy-binds-loopback-by-default/).
:::

### From an app host that is not on your tailnet

Give the proxy a certificate. With `proxyTls` set, it answers an `SSLRequest`
with `S`, terminates TLS itself, and **refuses a plaintext connection from any
other machine** with `FATAL 28000`. Loopback stays plaintext. That is what
makes `"all"` safe.

On the box, with a DNS name pointing at it (DNS only, not proxied: Cloudflare's
proxy cannot carry the Postgres protocol) and port 80 free:

```sh
certbot certonly --standalone -d db.example.com
```

Then set all three, for example in a systemd drop-in, since the daemon does not
read `/root/hobby.json` when started by systemd:

```ini
# /etc/systemd/system/hobby.service.d/tls.conf
[Service]
Environment=HOBBY_PROXY_HOST=all
Environment=HOBBY_PROXY_TLS_CERT=/etc/letsencrypt/live/db.example.com/fullchain.pem
Environment=HOBBY_PROXY_TLS_KEY=/etc/letsencrypt/live/db.example.com/privkey.pem
Environment=HOBBY_PROXY_TLS_HOSTNAME=db.example.com
```

`hobby new` then prints a third line, `public:`, a connection string for that
hostname ending in `?sslmode=require`. The certificate files are re-read when
they change, so certbot's renewals need no restart. All three settings or none:
a partial set stops the daemon from starting.
[ADR 0019](/docs/decisions/0019-the-proxy-terminates-tls/).

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

Resources that need a directly reachable host port are allocated one from a
range per kind, so a port number tells you what owns it:

| Kind | Range | Where |
|---|---|---|
| `postgres` | 15432 to 25432 | `PORT_RANGE_FROM` and `PORT_RANGE_TO`, `packages/pg/src/postgres.ts` |
| `app` | 25433 to 35432 | `APP_PORT_RANGE`, `packages/app/src/app.ts` |
| `worker` | 35433 to 45432 | `WORKER_PORT_RANGE`, `packages/worker/src/worker.ts`. Each worker takes two: its HTTP port and a control port |

That is the port `hobby ls` prints. It is not the port you normally dial: for
Postgres that is the proxy on 5432, which is what makes wake work, and an app
or worker is reached by hostname through the HTTP router on `httpPort`. Every
container port is published on loopback, so none of these ranges needs a
firewall rule; a candidate port is bound and released before it is handed out
(`allocateHostPort`, `packages/core/src/ports.ts`), so another process holding
one is skipped rather than collided with.

## Installer variables

Read by [the bootstrap script](/docs/install/#options), not by the daemon:

| Variable | Default | What |
|---|---|---|
| `HOBBY_SRC_DIR` | `~/.hobby/src` | Where the checkout lives |
| `HOBBY_REPO_REF` | `main` | Branch or tag to install |
| `HOBBY_REPO_URL` | the canonical repository | Where to clone from |
| `HOBBY_BIN_DIR` | `/usr/local/bin` or `~/.local/bin` | Where the launcher goes |
