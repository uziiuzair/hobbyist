---
title: The daemon, the proxy and Caddy
description: Three processes, three jobs, and the seams between them that are not negotiable.
sidebar:
  order: 3
---

<p class="state state--running">architecture</p>

```
  psql / ORM / app                     browser
        |                                 |
        | :5432                           | :443
        v                                 v
  hobby proxy  <------ wake ------>  caddy (managed container)
        |            (the router)         |
        |                                 v
        |                            hobby daemon
        |                            unix socket for cli + mcp
        |                            loopback tcp for studio
        v                                 |
  postgres container                      |
        |          <---- start/stop ------+
        v
  data directory     a plain PGDATA on a reflink-capable filesystem
```

The **daemon** owns state and lifecycle. The **proxy** owns the illusion, and is
also the activity sensor hibernation reads. **Caddy** owns TLS and HTTP routing.
The **data directory** owns the escape hatch.

## The daemon

One process, started with `hobby daemon`. It is the only thing in the system
that starts or stops a container, and the only thing that writes state.

It listens in two places:

- **A unix socket** at `~/.hobby/hobby.sock`, for the CLI and MCP. A socket
  rather than a port because filesystem permissions are the access control, and
  because a control plane that is not on the network cannot be reached from it.
- **Loopback TCP** on 7432, for Studio, which is a browser and cannot dial a
  unix socket.

Only one daemon may run at a time, and it enforces that rather than trusting it.

### The daemon API is the only control surface

CLI, Studio and MCP are three clients of one HTTP API, and none of them touches
Postgres or Docker directly. That turns "the CLI and MCP must never diverge"
from a discipline problem into a structural one: there is no second path for
them to diverge along. The API is described in
[the HTTP reference](/docs/reference/api/) and specified in
`docs/api/openapi.yaml`.

The API says `start` and `stop`, because those are mechanical container
operations. The CLI says `wake` and `sleep`, because that is the domain.
`cmdSleepWake` in `packages/cli/src/cli/commands.ts` is the one place that
translation happens.

### core knows nothing about Docker

`ComputeRuntime` (`packages/core/src/runtime.ts`) is the interface every
container operation goes through.
[ADR 0002](/docs/decisions/0002-containers-not-microvms/) calls it the escape
hatch: it is what would let a different runtime be swapped in, and much more
usefully day to day, it is what lets every lifecycle test run against a fake
with no Docker installed.

## The proxy

Speaks the Postgres wire protocol on 5432. Its job is to make a sleeping
database indistinguishable from a slow one.

It also cancels correctly, which is less obvious than it sounds: a Postgres
cancel request arrives on a *separate* connection carrying a process id and a
secret key, and a proxy that forwards it naively cancels the wrong query or
nothing at all.

The seam that matters: **the proxy asks, the engine acts.** The proxy never
starts a container. It calls `wake(resource)` and waits.

There is an HTTP counterpart for `app` and `worker` resources, on 7433,
answering the same shape of question for a request instead of a connection.

## Caddy

A managed container, driven through its admin API, which owns TLS and public
HTTP routing.
[ADR 0009](/docs/decisions/0009-caddy-as-http-front-door/) explains why a
managed container rather than a system service: it is one less thing to install,
one less thing whose version you have to care about, and it can be replaced
without touching the host.

**It is off by default.** `caddyEnabled` is `false` in the default config, and a
box that runs databases for one person over Tailscale never needs it. Turning it
on is [documented separately](/docs/guides/tls-and-domains/), along with the two
things it does not yet do: certificates are not persisted across a container
replacement, and it needs host networking, which is measured on Linux and
OrbStack and unmeasured on Docker Desktop for macOS.

## Ports

| Port | What | Exposure |
|---|---|---|
| 5432 | Postgres proxy | Whatever you bind it to |
| 7432 | Daemon API | Loopback only |
| 7433 | HTTP wake router | Behind Caddy |
| 7434 | Queue endpoint | Loopback and the project bridge |
| 8443 | Studio | Network, deliberately |
| 2019 | Caddy admin | Loopback only |

Every one of them is overridable. [Configuration](/docs/reference/configuration/).
