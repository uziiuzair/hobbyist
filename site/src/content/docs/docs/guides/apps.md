---
title: Apps
description: Any Dockerfile, built and served over HTTP, asleep until a request arrives.
sidebar:
  order: 2
---

<p class="state state--starting">works, rough edges</p>

An `app` is any Dockerfile. Hobbyist builds it, gives it a hostname, and sleeps
it when nothing is asking for it. Cold start measured at p50 121ms, p95 133ms on
an Apple M5 Pro, 2026-08-10.

## Deploy

```sh
cd ./my-app
hobby deploy
```

The kind is detected from what is in the directory rather than asked for,
because you already said which you meant by what you wrote: a `Dockerfile` means
an app, a `wrangler.toml` or `wrangler.jsonc` means a
[worker](/docs/guides/workers/). Both present is an error that asks which,
rather than a guess, because guessing wrong means building the wrong thing and
finding out when it fails to serve.

```sh
hobby deploy ./my-app --project blog --name site --port 8080
```

| Flag | What |
|---|---|
| `--project <p>` | Which project it belongs to |
| `--name <n>` | The resource name |
| `--port <n>` | The port your process listens on inside the container |
| `--kind app\|worker` | Only needed when the directory is ambiguous |
| `--json` | Machine-readable output |

## Your Dockerfile

Nothing special is required. The one thing that matters is that your process
listens on the port you told Hobbyist about, and that it binds `0.0.0.0` rather
than `127.0.0.1`, because a process bound to loopback inside a container is
unreachable from outside it.

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
```

## Create now, deploy later

```sh
hobby create app site --project blog
```

That writes a resource row with an id and a hostname and no code, resting in the
state `undeployed`. `hobby ls` marks it `(no code yet)`.

This exists because creating a resource and deploying code to it are two acts,
not one. Before the split, the daemon refused to write a row without a build
source, which meant Studio and MCP could not create an app at all, having no
filesystem path to hand over.
[ADR 0014](/docs/decisions/0014-resource-records-exist-before-code/).

There is deliberately no `--port` on `hobby create`. A port describes your code,
and your code does not exist yet.

## Stateless on purpose

An app has no data directory. It gets its persistence from
[Postgres](/docs/guides/postgres/). Volumes are Phase 3, which keeps volume
lifecycle out of the phase that was already the hardest.
[ADR 0007](/docs/decisions/0007-hobbyist-is-a-platform/).

## Reaching it

An app is reached by hostname rather than by port, because its port is an
implementation detail nobody wants to type. In front of that sits either
[Caddy](/docs/guides/tls-and-domains/) for public HTTPS, or
[Tailscale](/docs/guides/tailscale-and-tunnels/) for a private lane.

## Not a git push flow

Deliberately. A push-to-deploy flow needs a receiving repository, a hook, and a
build triggered by someone else's commit, none of which is one box's worth of
complexity. `hobby deploy` from the directory you are already standing in is the
same number of keystrokes.
