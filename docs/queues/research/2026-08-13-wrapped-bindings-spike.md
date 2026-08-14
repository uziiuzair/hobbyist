# Wrapped bindings spike: does a wrapped binding reach the host?

Status: NOTES. Evidence gathered 2026-08-13, before any queue code existed.
Date:   2026-08-13

The producer path in the queues plan replaces Cloudflare's queue binding with
our own JS object, supplied to a worker through Miniflare's `wrappedBindings`
option, so that `env.MY_Q.send(body)` posts to a daemon on the host instead of
into Miniflare's in-memory broker (see
`docs/queues/research/2026-08-13-miniflare-queues-are-in-memory.md` for why
the in-memory broker is unusable). This has been read about and not run.
Everything else in the queues plan depends on it, so it is settled here, in a
scratch directory, before Task 12 writes any real code.

Three things had to hold, from the task brief:

1. Miniflare starts with two workers and a `wrappedBindings` entry, with no
   schema error.
2. `env.MY_Q.send()` exists on the user worker and is callable.
3. The host listener receives the POST with the bearer header intact.

**All three hold, after fixing one schema error the brief's draft config did
not anticipate.**

## Setup

Host: macOS 25.3.0, Apple Silicon, OrbStack (`docker info` reports
`OperatingSystem: OrbStack`, server `linux/arm64`). Container:
`node:22-bookworm-slim`, node `v22.23.2` inside the container. Miniflare
installed at exactly `4.20260730.0`, the version pinned by
`MINIFLARE_VERSION` in `packages/worker/src/runtime-image.ts:21`.

Four files in a scratch directory (not committed, per the task brief):

`shim.mjs`, the wrapped binding's module, unchanged from the brief:

```js
export default function makeBinding(env) {
  return {
    async send(body) {
      const res = await fetch(env.HOBBY_QUEUE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.HOBBY_QUEUE_TOKEN },
        body: JSON.stringify({ queue: 'spike', messages: [{ body: JSON.stringify(body), contentType: 'json' }] }),
      })
      if (!res.ok) throw new Error('enqueue failed: ' + res.status)
      return await res.json()
    },
  }
}
```

`worker.mjs`, the user worker standing in for a real one, unchanged from the
brief:

```js
export default {
  async fetch(request, env) {
    const result = await env.MY_Q.send({ hello: 'world', at: new Date().toISOString() })
    return Response.json({ sent: result })
  },
}
```

`listener.mjs`, a Node HTTP server on `127.0.0.1:7799` that logs the method,
the `authorization` header and the body, then replies `200
{"ids":["spike-1"]}`, matching the brief's step 2.

`run.mjs`, the runner. This is where the fix lives; see below for what
changed from the brief's draft.

## What failed first, and the fix

The brief's draft `run.mjs` put `compatibilityDate: '2026-08-01'` on both
workers, including the `hobby-queue-shim` worker that the wrapped binding
points at. That worker failed to start:

```
$ docker run --rm -v <scratch>:/spike -p 8787:8787 \
    -e HOBBY_QUEUE_URL=http://host.docker.internal:7799/enqueue \
    -w /spike node:22-bookworm-slim \
    sh -c "npm install --no-audit --no-fund miniflare@4.20260730.0 && node run.mjs"

/spike/node_modules/miniflare/dist/src/index.js:93535
        throw new MiniflareCoreError("ERR_INVALID_WRAPPED", message);
              ^

MiniflareCoreError [ERR_INVALID_WRAPPED]: Cannot use "hobby-queue-shim" for wrapped binding because it defines a compatibility date.
Wrapped bindings use the compatibility date of the worker with the binding.
    at invalidWrapped2 (/spike/node_modules/miniflare/dist/src/index.js:93535:15)
    at Object.getServices (/spike/node_modules/miniflare/dist/src/index.js:93562:9)
    at #assembleConfig (/spike/node_modules/miniflare/dist/src/index.js:104013:56)
    at async #assembleAndUpdateConfig (/spike/node_modules/miniflare/dist/src/index.js:104260:21)
    at async Mutex.runWith (/spike/node_modules/miniflare/dist/src/index.js:72013:48)
    at async #waitForReady (/spike/node_modules/miniflare/dist/src/index.js:104442:5)
    at async file:///spike/run.mjs:27:13 {
  code: 'ERR_INVALID_WRAPPED',
  cause: undefined
}
```

This is a real constraint in Miniflare `4.20260730.0`, not a typo in the
spike: a worker referenced as a `wrappedBindings` target must not declare its
own `compatibilityDate`. It inherits the date of the worker holding the
binding. The fix is to drop `compatibilityDate` from the shim worker's
options entirely:

```js
{
  name: 'hobby-queue-shim',
  modules: true,
  scriptPath: '/spike/shim.mjs',
  bindings: {
    HOBBY_QUEUE_URL: process.env.HOBBY_QUEUE_URL,
    HOBBY_QUEUE_TOKEN: 'spike-token',
  },
}
```

This is the one thing Task 13's implementer needs to carry forward: the
runner must not stamp a `compatibilityDate` onto any worker that is only a
`wrappedBindings` target, our shim included.

## The run that worked

With the fix applied:

```
$ docker run --rm -v <scratch>:/spike -p 8787:8787 \
    -e HOBBY_QUEUE_URL=http://host.docker.internal:7799/enqueue \
    -w /spike node:22-bookworm-slim \
    sh -c "npm install --no-audit --no-fund miniflare@4.20260730.0 && node run.mjs"

added 2 packages in 3s
spike: listening on http://127.0.0.1:8787/
```

From the host:

```
$ curl -s localhost:8787
{"sent":{"ids":["spike-1"]}}
```

The listener's own log, for the request that arrived from inside the
container (earlier lines in the same log are from a direct `curl` used to
confirm the listener worked before the container ran, and are not part of
this result):

```
LISTENER: POST /enqueue
LISTENER: authorization=Bearer spike-token
LISTENER: body={"queue":"spike","messages":[{"body":"{\"hello\":\"world\",\"at\":\"2026-08-13T15:48:00.478Z\"}","contentType":"json"}]}
```

`docker exec` into the running container confirmed the pinned version was
what actually installed and ran:

```
$ docker exec <container> sh -c "node --version && cat node_modules/miniflare/package.json | grep '\"version\"'"
v22.23.2
  "version": "4.20260730.0",
```

## Verdict

1. **Miniflare starts with two workers and a `wrappedBindings` entry, with no
   schema error: yes**, once the shim worker's `compatibilityDate` is
   removed. With it present, Miniflare refuses to start at all
   (`ERR_INVALID_WRAPPED`), which is a schema-level rejection, not a runtime
   failure, so this is worth flagging clearly for Task 13: get the shim
   worker's options minimal, no `compatibilityDate`, or the runner will not
   boot.
2. **`env.MY_Q.send()` exists on the user worker and is callable: yes.** The
   `fetch` handler in `worker.mjs` called it directly and the response body,
   `{"sent":{"ids":["spike-1"]}}`, is the shim's return value flowing back
   through `env.MY_Q.send()` unmodified.
3. **The POST arrives at the host listener with the bearer header intact:
   yes.** The listener's log shows `authorization=Bearer spike-token`,
   matching the `HOBBY_QUEUE_TOKEN` binding set on the shim worker, and a body
   matching exactly what `shim.mjs` constructs.

All three conditions hold. The producer mechanism the rest of the queues plan
depends on works as designed, with one correction to the wrapped worker's
options that Task 13 must carry forward.

## Decision for Task 13

**The wrapped-binding approach is confirmed and is the path to build.** No
fallback is needed. The one adjustment from the brief's draft config: the
`wrappedBindings` target worker (the shim) must be configured without a
`compatibilityDate`. It runs at the compatibility date of the worker holding
the binding, and setting one on the shim worker itself is a hard startup
error (`ERR_INVALID_WRAPPED`), not a warning.

The fallback named in the task brief, a shim that posts to
`http://127.0.0.1:<controlPort>/enqueue` on the container's own loopback with
the runner's control server forwarding to the daemon, is recorded here for
completeness but is not needed: the wrapped binding reached
`host.docker.internal` directly in this spike, consistent with the loopback
reachability already measured in
`docs/queues/research/2026-08-13-miniflare-queues-are-in-memory.md` (both
`host.docker.internal` and `host.orb.internal` reach a host listener bound to
`127.0.0.1` under OrbStack). That doc's Linux caveat still applies here
unchanged: `host.docker.internal` on Linux resolves to the bridge gateway,
not to loopback, so the daemon's listener needs a bind reachable from the
bridge address on Linux, and this spike does not change that fact one way or
the other. It was not re-tested here because it is a host-networking property
of the transport, not of the wrapped binding, and the miniflare-in-memory
research doc already covers it.

## Reproducing

The spike lived in four files in a scratchpad directory, none of them kept:
`shim.mjs`, `worker.mjs`, `listener.mjs`, and `run.mjs`. Everything needed to
rebuild them is quoted above. Nothing under `packages/` was touched.
