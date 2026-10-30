---
title: Next.js on Hobby
description: The image shape that fits a small box, the build arguments a Next.js app needs, and how to build somewhere else when the box cannot.
sidebar:
  order: 11
---

<p class="state state--starting">works, with the shape below. the off-box path is documented, not yet run end to end here</p>

A Next.js app is an [app](/docs/guides/apps/): a Dockerfile, built on the box
and served over HTTP, asleep until a request arrives. Nothing here is specific
to Hobby except the part about the box being small. This page exists because
a real production monorepo was deployed in October 2026 and did not fit.

## The problem, with numbers

Four Next.js apps from one monorepo, each built from a Dockerfile that copied
the whole repository into the image: 2.75GB, 2.47GB, 2.41GB and 1.98GB. The
largest took 2 minutes 48 seconds to build cold on an Apple Silicon Mac with a
6GB Node heap. The target box for this project is 1 vCPU and 1GB of memory. A
build that needs six times the machine's memory does not get slower there, it
does not finish.

Two things follow. First, the image shape matters more than it does on a
laptop. Second, when the shape is right and the build still does not fit, the
build has to happen somewhere else, and only the result travels to the box.

## The image shape that fits

Next.js can emit a self-contained server with only the files it needs
(`output: 'standalone'`). That is the shape to ship:

```js
// next.config.js
module.exports = {
  output: 'standalone',
}
```

```dockerfile
# Dockerfile
FROM node:22-alpine AS build
WORKDIR /repo
COPY package*.json ./
RUN npm ci
COPY . .
ARG NEXT_PUBLIC_API_URL
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo/.next/standalone ./
COPY --from=build /repo/.next/static ./.next/static
COPY --from=build /repo/public ./public
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "server.js"]
```

The second stage carries the standalone server, the static assets and
`public`, and nothing else: no source, no `node_modules` beyond what the
standalone trace pulled in, no `.git`. `HOSTNAME=0.0.0.0` is the Next.js way
of binding every interface inside the container, which an app on Hobby has to
do, because a process bound to loopback inside a container is unreachable from
the host ([Your Dockerfile](/docs/guides/apps/#your-dockerfile)).

```sh
hobby deploy . --project cl --name web --port 3000 --dockerfile apps/web/Dockerfile
```

For a monorepo, `[path]` is the repository root (the build context) and
`--dockerfile` names the file inside it, one per app
([Monorepos](/docs/guides/apps/#monorepos)). Both are persisted, so
`hobby deploy . --name web` later rebuilds the same way.

## `NEXT_PUBLIC_*` values are build arguments

Next.js inlines any `NEXT_PUBLIC_*` variable into the client bundle **at build
time**. Setting one with `--env` or `hobby env set` is too late: those are
read when the container starts, and the bundle was already written. Pass them
as build arguments, which `hobby deploy` persists with the resource and hands
to `docker build --build-arg` on every rebuild:

```sh
hobby deploy . --project cl --name web --port 3000 \
  --dockerfile apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.cl.example
```

The Dockerfile has to declare `ARG NEXT_PUBLIC_API_URL` before the `RUN npm
run build` that reads it, as the example above does. A build argument is baked
into the image by whatever reads it, which is exactly what a public URL wants
and exactly what a secret must never be. Everything the server reads at
runtime, `DATABASE_URL` above all, is an ordinary
[environment variable](/docs/guides/apps/#environment-variables-and-secrets);
bind a sibling database with `--database` and `DATABASE_URL` arrives by
itself, through the wake proxy.

Build argument values are redacted on every API response like env values, but
redaction on the wire does not take them out of the image.

## When it still does not fit: build off the box

`hobby deploy` runs `docker build` on the box. There is no flag that takes a
prebuilt image instead, and no step that ships an image from your laptop. What
there is: `docker build` pulls any base image it does not have. So a Dockerfile
that is nothing but a `FROM` line is a build the box can always do.

On the machine with the memory:

```sh
docker build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_API_URL=https://api.cl.example \
  -f apps/web/Dockerfile -t ghcr.io/you/cl-web:2026-10-30 .
docker push ghcr.io/you/cl-web:2026-10-30
```

`--platform` has to match the box. An image built on an Apple Silicon Mac
without it is `linux/arm64` and will not run on an x86 VPS.

Then, in a directory of its own, a Dockerfile the box can build in a second:

```dockerfile
# deploy/web/Dockerfile
FROM ghcr.io/you/cl-web:2026-10-30
```

```sh
hobby deploy deploy/web --project cl --name web --port 3000
```

The box pulls the image, tags it, and serves it. A redeploy is a new tag in
that one-line Dockerfile and the same command. A private registry needs the
box's Docker to be logged in to it (`docker login` on the box); Hobby does not
carry credentials for registries and has nowhere to put them.

Two honest notes on this path. It relies only on `docker build`'s ordinary
behaviour, and nobody has yet run it end to end against a Hobby box and
written the result down, so if you do, file what you saw. And the daemon API
can create an app directly from an image reference,
`POST /v1/projects/{name}/resources` with `{ "kind": "app", "image": "...",
"port": 3000 }` (`createResourceRoute`, `packages/cli/src/daemon/routes.ts`,
and the `image` branch of `createAppResource`, `packages/app/src/app.ts`),
but no CLI verb exposes it and no route changes the image of an existing app
afterwards, so it is a one-shot the one-line Dockerfile does not have. Prefer
the Dockerfile.

## What to expect once it runs

A Next.js app measured on a $5 VPS (1 vCPU, 1GB, ext4) woke in p50 1828ms,
p95 1989ms on 2026-08-22, against a 3 second ceiling. That is the whole wake:
container start plus Next.js's own boot, which is most of it. Keep the server
light and it stays inside the budget; see
[Sleep and wake](/docs/concepts/sleep-and-wake/#the-budget).

An app and its database sleep on independent timers. Bind the database with
`--database` so the app's `DATABASE_URL` goes through the wake proxy and its
first query wakes the database; an app that builds its own connection string
against the container name will find the name unresolvable while the database
sleeps ([Alpha status](/docs/status/#an-app-cannot-wake-its-own-database-by-container-name)).
