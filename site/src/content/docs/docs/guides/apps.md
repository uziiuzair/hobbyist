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
| `--database <r>` | A sibling Postgres resource to bind. The app gets `DATABASE_URL`, see below |
| `--env-file <f>` | Variables from a dotenv file, see below |
| `--env K=V` | One variable, repeatable, see below |
| `--kind app\|worker` | Only needed when the directory is ambiguous |
| `--json` | Machine-readable output |

## Environment variables and secrets

```sh
hobby deploy ./my-app --project blog --env-file .env.production
hobby deploy ./my-app --project blog --env MODE=prod --env API_KEY=sk-...
```

After the app exists, change them without a rebuild:

```sh
hobby env set blog/my-app API_KEY=sk-...
hobby env ls blog/my-app          # names only
hobby env unset blog/my-app MODE
```

A change is read at the app's next start. If the app is running it is stopped,
and the next request wakes it with the new values; the command tells you which
happened. There is no secrets vault here and none is planned: these are plain
per-resource variables, stored with the resource's config and redacted on every
API response, which is enough for one person's box.

The file is read on the machine you run `hobby` from and sent to the daemon, so
it never has to exist on a [remote box](/docs/guides/remote/). One `KEY=VALUE`
per line. Blank lines and `#` comments are skipped, an `export ` prefix is
allowed, and one pair of matching quotes around a value is stripped. Nothing is
interpolated: `$OTHER` arrives as written.

On a redeploy the file replaces the app's variables as a whole, so a key you
delete from it is gone afterwards. `--env K=V` wins over the same key in the
file. A redeploy with neither keeps what the app already has. Values are never
printed, only a count.

A database bound with `--database` always supplies `DATABASE_URL`, even if the
file sets one too. That URL goes through the wake proxy, the same way your own
`psql` does, so the app's first query wakes a sleeping database and its open
connections keep it awake for as long as the app is. Workers take plain
variables from `[vars]` in their wrangler config and secrets from `.dev.vars`,
`--env`, `--env-file` or `hobby env set`; see the
[workers guide](/docs/guides/workers/#secrets).

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

## Monorepos

`[path]` is the build context, and `--dockerfile` names the file inside it, so
several apps that all need the repository root as context deploy from the same
root with one Dockerfile each:

```sh
hobby deploy . --project cl --name web     --dockerfile deploy/hobby/web.Dockerfile
hobby deploy . --project cl --name admin   --dockerfile deploy/hobby/admin.Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.cl.example
```

Both are persisted with the resource, so `hobby deploy . --name admin` later
rebuilds with the same file and the same arguments. A `--build-arg` is inlined
into the image by whatever `ARG` reads it, which is what `NEXT_PUBLIC_*` values
need and what a secret must never be: use [environment variables](#environment-variables-and-secrets)
for anything the running process reads.

The build runs on the box, in Docker, with whatever memory the box has. A
Next.js monorepo that copies the whole repository into the image does not fit
a 1GB VPS; [Next.js on Hobby](/docs/guides/nextjs/) has the shape that does,
and the way to build elsewhere when it still does not.

Two things to know about that. Builds are not capped: `docker build` under
BuildKit accepts `--memory` and `--cpu-shares` and ignores them (measured;
see `docs/compute/CLAUDE.md`), so Hobby no longer passes them and a build
that needs more than the box has will fail or starve the box. And one image
builds at a time, apps and workers alike: a deploy that starts while another
build is running waits for it, and its build output begins with `hobby: build
queued behind another build`.

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
