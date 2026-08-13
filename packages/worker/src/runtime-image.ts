// The container a Worker runs in: Bun, Miniflare, and the user's bundled
// Worker. One image per worker resource, built from the user's own directory
// as the build context, exactly like the `app` kind builds a Dockerfile.
//
// The Dockerfile is generated rather than asked for. A Worker's build is not
// a thing the user should have to describe: wrangler already knows how to
// build one and the manifest already says which file is the entry point.
//
// The runner is embedded base64 rather than COPYed, because the build context
// is the USER'S directory and a COPY can only reach files that are already in
// it. Writing our runner into their source tree to make COPY work would mean
// hobby leaving files in a directory it does not own, which is exactly the
// kind of thing `hobby eject` exists to promise we do not do.

import { HobbyError, type BuildSpec, type ComputeRuntime } from '@hobby.sh/core'

// Pinned, and not to `latest`. As of 2026-08-10 npm's `latest` tag for
// miniflare is 5.20260801.1-alpha; running an alpha as a server would be a
// second bet on top of the one ADR 0011 already takes by using a documented
// dev tool as a server. This is the newest non-prerelease.
export const MINIFLARE_VERSION = '4.20260730.0'

// Two stages, and the split is not an optimisation.
//
// Bun BUILDS (ADR 0006 already made it the toolchain, and `bun build` bundles
// for the workerd conditions). Node RUNS, because Miniflare does not work
// under Bun: it spawns workerd with a control pipe on fd 3 and asserts
// `runtimeProcess.stdio[3] instanceof Readable`, which Bun's child_process
// does not satisfy. Found by running it, not by reading anything:
//
//   AssertionError: false == true
//     at updateConfig (/hobby/node_modules/miniflare/dist/src/index.js)
//
// This is the first concrete cost of ADR 0011's "a dev tool is load-bearing
// in the request path", and it is a cheap one: one extra base image.
export const BUN_IMAGE = 'oven/bun:1-alpine'
// Debian, not Alpine, and this one also cost a run to find. workerd ships
// glibc binaries; on a musl base the spawn fails with
//
//   Error: spawn /hobby/node_modules/@cloudflare/workerd-linux-arm64/bin/workerd ENOENT
//
// which reads like a missing file and is actually a missing platform. Alpine
// would have been the smaller image and it cannot run this runtime at all.
export const NODE_IMAGE = 'node:22-bookworm-slim'

// Where everything of ours lives inside the container, kept well away from
// the user's own /src so a project with a `hobby` directory cannot collide.
export const CONTAINER_ROOT = '/hobby'
export const CONTAINER_STATE = `${CONTAINER_ROOT}/state`
export const CONTAINER_DO = `${CONTAINER_ROOT}/do`

// The control channel's port INSIDE the container. Fixed, like CONTAINER_PORT
// in worker.ts is for Miniflare's own listener: nothing else in this
// container needs it, so a constant is one fewer thing to keep in sync
// between the runner and the port mapping. worker.ts's containerSpec
// publishes this on the host under the resource's own controlPort, the same
// way it already does for the main port.
export const CONTAINER_CONTROL_PORT = 8788

// packages/queue/src/codec.ts, compiled to plain JavaScript so it can run
// with no build step inside a Miniflare worker, which is otherwise plain
// JavaScript itself (`node runner.mjs`, no ts-node, no --experimental-strip-
// types). The logic below is unchanged from that file: only the TypeScript
// type annotations (the `Node` type alias and the parameter/return types)
// are gone, because Node's own parser rejects them on a script with no
// TypeScript loader, which is what this one is. If codec.ts changes, this
// has to change with it by hand; there is no automated compile step wiring
// the two together, which is a real risk this comment exists to flag.
//
// The daemon never calls this. It stores the string and never parses it: the
// broker's job is to hold bytes durably, not to understand them. Both ends
// that DO call it are inside a container: the producer shim below encodes,
// and the control worker below decodes.
//
// The format is a flat array of tagged nodes. Index 0 is the root, and every
// reference is an index into the same array, which is what makes cycles and
// shared references work: a graph, not a tree.
const CODEC_SOURCE_JS = `function encodeBody(value) {
  const nodes = []
  const seen = new Map()

  function write(input) {
    if (input === undefined) {
      nodes.push(['undef'])
      return nodes.length - 1
    }
    if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
      nodes.push(['prim', input])
      return nodes.length - 1
    }
    if (typeof input === 'bigint') {
      nodes.push(['big', input.toString()])
      return nodes.length - 1
    }

    const existing = seen.get(input)
    if (existing !== undefined) {
      return existing
    }

    if (input instanceof Date) {
      nodes.push(['date', input.getTime()])
      const index = nodes.length - 1
      seen.set(input, index)
      return index
    }
    if (input instanceof RegExp) {
      nodes.push(['regexp', input.source, input.flags])
      const index = nodes.length - 1
      seen.set(input, index)
      return index
    }

    // The slot is reserved BEFORE the children are written, so a child that
    // refers back to this node finds an index rather than recursing forever.
    if (Array.isArray(input)) {
      const node = ['array', []]
      nodes.push(node)
      const index = nodes.length - 1
      seen.set(input, index)
      for (const item of input) {
        node[1].push(write(item))
      }
      return index
    }
    if (input instanceof Map) {
      const node = ['map', []]
      nodes.push(node)
      const index = nodes.length - 1
      seen.set(input, index)
      for (const [key, item] of input) {
        node[1].push([write(key), write(item)])
      }
      return index
    }
    if (input instanceof Set) {
      const node = ['set', []]
      nodes.push(node)
      const index = nodes.length - 1
      seen.set(input, index)
      for (const item of input) {
        node[1].push(write(item))
      }
      return index
    }

    const node = ['object', []]
    nodes.push(node)
    const index = nodes.length - 1
    seen.set(input, index)
    for (const [key, item] of Object.entries(input)) {
      node[1].push([key, write(item)])
    }
    return index
  }

  write(value)
  return JSON.stringify(nodes)
}

function decodeBody(text) {
  const nodes = JSON.parse(text)
  const built = new Array(nodes.length)
  const done = new Array(nodes.length).fill(false)

  // Two passes for the same reason encode reserves slots: a container has to
  // exist before its children can point at it.
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node === undefined) continue
    switch (node[0]) {
      case 'prim':
        built[i] = node[1]
        done[i] = true
        break
      case 'undef':
        built[i] = undefined
        done[i] = true
        break
      case 'big':
        built[i] = BigInt(node[1])
        done[i] = true
        break
      case 'date':
        built[i] = new Date(node[1])
        done[i] = true
        break
      case 'regexp':
        built[i] = new RegExp(node[1], node[2])
        done[i] = true
        break
      case 'array':
        built[i] = []
        break
      case 'object':
        built[i] = {}
        break
      case 'map':
        built[i] = new Map()
        break
      case 'set':
        built[i] = new Set()
        break
    }
  }

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node === undefined || done[i] === true) continue
    if (node[0] === 'array') {
      const target = built[i]
      for (const ref of node[1]) target.push(built[ref])
    } else if (node[0] === 'object') {
      const target = built[i]
      for (const [key, ref] of node[1]) target[key] = built[ref]
    } else if (node[0] === 'map') {
      const target = built[i]
      for (const [keyRef, valueRef] of node[1]) target.set(built[keyRef], built[valueRef])
    } else if (node[0] === 'set') {
      const target = built[i]
      for (const ref of node[1]) target.add(built[ref])
    }
  }

  return built[0]
}`

// The wrapped binding that replaces Cloudflare's queue producer binding.
// Given to the user worker through Miniflare's wrappedBindings, one entry per
// producer binding, all pointing at this one worker (see the workers array
// below). Each wrappedBindings entry carries its own HOBBY_QUEUE_NAME in its
// own bindings, which is what lets this single module serve every producer a
// worker declares: makeBinding(env) is called once per entry, with that
// entry's own bindings as env.
//
// No compatibilityDate is set on the worker this module becomes (see the
// workers array below): Miniflare 4.20260730.0 refuses to start at all with
// ERR_INVALID_WRAPPED if a wrappedBindings target declares its own, verified
// against a running Miniflare on 2026-08-13
// (docs/queues/research/2026-08-13-wrapped-bindings-spike.md). It runs at the
// compatibility date of the worker holding the binding instead.
const QUEUE_SHIM_SOURCE = `${CODEC_SOURCE_JS}

export default function makeBinding(env) {
  async function post(messages) {
    const res = await fetch(env.HOBBY_QUEUE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + env.HOBBY_QUEUE_TOKEN,
      },
      body: JSON.stringify({ queue: env.HOBBY_QUEUE_NAME, messages }),
    })
    if (!res.ok) {
      throw new Error('enqueue failed: ' + res.status)
    }
    return await res.json()
  }

  function encodeMessage(body, options) {
    const message = { body: encodeBody(body), contentType: 'json' }
    if (options && typeof options.delaySeconds === 'number') {
      message.delaySeconds = options.delaySeconds
    }
    return message
  }

  return {
    async send(body, options) {
      return post([encodeMessage(body, options)])
    },
    async sendBatch(messages) {
      return post((messages || []).map(function (entry) {
        return encodeMessage(entry.body, entry)
      }))
    },
  }
}`

// The only thing the daemon's control port talks to. A service binding to
// the user's worker, making the same call Miniflare's own queue broker makes
// (broker.worker.js's #dispatchBatch): env.USER.queue(queueName, messages,
// metadata). That call only exists on the service binding because of the
// service_binding_extra_handlers compatibility flag set on THIS worker in
// the workers array below; the user's own worker does not need it.
const CONTROL_SOURCE = `${CODEC_SOURCE_JS}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('method not allowed', { status: 405 })
    }
    const payload = await request.json()
    const messages = (payload.messages || []).map(function (message) {
      return {
        id: message.id,
        // Message.timestamp is a Date on the real Fetcher#queue contract
        // (confirmed against miniflare's own broker.worker.ts, which passes
        // the Date straight through); the wire carries milliseconds since
        // the epoch, same as the rest of this project's timestamps.
        timestamp: new Date(message.timestamp),
        // The daemon stores an opaque, codec-encoded body and never parses
        // it. Decoding happens here, inside the container, the other end of
        // the same codec the producer shim above encodes with, so a Date or
        // a Map queued on one side comes back as a Date or a Map on the
        // other, not a flattened string.
        body: decodeBody(message.body),
        attempts: message.attempts,
      }
    })
    const metadata = payload.metadata || { metrics: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: 0 } }
    const result = await env.USER.queue(payload.queue, messages, metadata)
    return Response.json(result)
  },
}`

// The process inside the container. Reads its whole configuration from one
// environment variable, so nothing about a specific worker is baked into the
// image beyond its own bundled code.
//
// Kept as a string rather than a file in this package because it has to be
// embedded in a generated Dockerfile, and a second copy on disk that could
// drift from this one is worse than a template literal.
export const RUNNER_SOURCE = `import { Miniflare } from 'miniflare'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const raw = process.env.HOBBY_WORKER_MANIFEST
if (!raw) {
  console.error('hobby: HOBBY_WORKER_MANIFEST is not set; nothing to run')
  process.exit(1)
}
const manifest = JSON.parse(raw)

// Written once per container start, beside the user's own bundle, so
// Miniflare can load them from disk exactly like it loads worker.mjs. Their
// source lives in this file (runtime-image.ts), not on disk in the repo,
// for the same reason RUNNER_SOURCE itself does: a generated Dockerfile has
// to carry it as a string, and a second copy on disk that could drift from
// this one is worse than a template literal.
writeFileSync('${CONTAINER_ROOT}/queue-shim.mjs', ${JSON.stringify(QUEUE_SHIM_SOURCE)}, 'utf8')
writeFileSync('${CONTAINER_ROOT}/control.mjs', ${JSON.stringify(CONTROL_SOURCE)}, 'utf8')

// One wrappedBindings entry per producer binding, all pointing at the same
// shim worker (Miniflare merges an entry's own "bindings" into the env
// makeBinding(env) receives, which is what lets one shim module serve every
// producer a worker declares).
const wrappedBindings = {}
for (const entry of manifest.queueBindings || []) {
  wrappedBindings[entry.binding] = {
    scriptName: 'hobby-queue-shim',
    bindings: {
      HOBBY_QUEUE_URL: manifest.queueEndpoint,
      HOBBY_QUEUE_TOKEN: manifest.queueToken,
      HOBBY_QUEUE_NAME: entry.queue,
    },
  }
}

const mf = new Miniflare({
  workers: [
    {
      name: 'user',
      modules: true,
      scriptPath: '${CONTAINER_ROOT}/worker.mjs',
      compatibilityDate: manifest.compatibilityDate,
      compatibilityFlags: manifest.compatibilityFlags ?? [],
      bindings: manifest.vars ?? {},
      kvNamespaces: manifest.kvNamespaces ?? [],
      r2Buckets: manifest.r2Buckets ?? [],
      d1Databases: manifest.d1Databases ?? [],
      // ALWAYS empty, unconditionally, no matter what the manifest carries.
      // Miniflare's own queue broker (QueueBrokerObject) keeps its backlog
      // in memory by its own source comment, so if it is ever constructed
      // here it will accept sends and never deliver them: the symptom is
      // messages disappearing sometimes, not a wiring error anyone can find
      // (ADR 0013). The real producer binding is the wrappedBindings entry
      // below; the real consumer delivery is the control port, not this.
      queueProducers: [],
      queueConsumers: [],
      durableObjects: manifest.durableObjects ?? {},
      ...(manifest.hyperdrives ? { hyperdrives: manifest.hyperdrives } : {}),
      ...(Object.keys(wrappedBindings).length > 0 ? { wrappedBindings } : {}),
    },
    {
      name: 'hobby-queue-shim',
      modules: true,
      scriptPath: '${CONTAINER_ROOT}/queue-shim.mjs',
      // No compatibilityDate. See the comment on QUEUE_SHIM_SOURCE above:
      // Miniflare rejects one on a wrappedBindings target at startup with
      // ERR_INVALID_WRAPPED. Setting one here is the natural thing to write
      // and it makes the whole runner fail to boot.
    },
    {
      name: 'hobby-control',
      modules: true,
      scriptPath: '${CONTAINER_ROOT}/control.mjs',
      compatibilityDate: manifest.compatibilityDate,
      // What makes Fetcher#queue exist on the USER service binding below.
      // Miniflare's own broker sets the same flag on itself for the same
      // reason (broker.worker.js).
      compatibilityFlags: ['service_binding_extra_handlers'],
      serviceBindings: { USER: 'user' },
    },
  ],
  // Explicit per-plugin paths, never defaultPersistRoot. Verified against a
  // running Miniflare on 2026-08-10: defaultPersistRoot inserts a plugin
  // segment of its own, so durable object storage would land at
  // <root>/do/<uniqueKey>/... and the daemon's alarm mirror scans a directory
  // that is supposed to hold nothing else.
  kvPersist: '${CONTAINER_STATE}/kv',
  r2Persist: '${CONTAINER_STATE}/r2',
  d1Persist: '${CONTAINER_STATE}/d1',
  cachePersist: '${CONTAINER_STATE}/cache',
  durableObjectsPersist: '${CONTAINER_DO}',
  // 0.0.0.0, not 127.0.0.1: a loopback bind inside a container is
  // unreachable from the host, which is the single most common way a
  // containerised server looks healthy and serves nobody. The container's
  // port is published on the host's loopback only, which is where the
  // isolation actually comes from.
  host: '0.0.0.0',
  port: manifest.port,
})

const url = await mf.ready
console.log('hobby: worker listening on ' + url.toString())

// The control channel: a second, unrelated HTTP server the daemon posts
// queue batches to. Kept OUT of Miniflare and out of the request path on
// purpose: the user's worker stays the entry worker, with nothing in front
// of it, because fronting it would put our code in the way of every
// request, including Durable Object WebSocket upgrades and streamed
// responses, to serve a channel used a few times a second at most.
const controlServer = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/queue') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
    return
  }
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    ;(async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        const worker = await mf.getWorker('hobby-control')
        const upstream = await worker.fetch('http://hobby-control/queue', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        const text = await upstream.text()
        res.writeHead(upstream.status, { 'content-type': 'application/json' })
        res.end(text)
      } catch (err) {
        console.error('hobby: control channel error: ' + (err instanceof Error ? err.stack : String(err)))
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'control channel failure' }))
      }
    })()
  })
})
// 0.0.0.0, for the same reason the worker port above is. Published to the
// host's loopback only, exactly as the worker port already is.
controlServer.listen(${CONTAINER_CONTROL_PORT}, '0.0.0.0', () => {
  console.log('hobby: control channel listening on container port ${CONTAINER_CONTROL_PORT}, published on host port ' + manifest.controlPort)
})

// A clean shutdown, so a sleep does not look like a crash to whatever the
// worker was talking to, and so Durable Object storage is flushed rather
// than recovered on the next wake.
const shutdown = async () => {
  try {
    controlServer.close()
    await mf.dispose()
  } finally {
    process.exit(0)
  }
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
`

export interface WorkerDockerfileOptions {
  // The Worker entry point, relative to the build context, from the
  // manifest's own `main`.
  main: string
}

export function renderWorkerDockerfile(opts: WorkerDockerfileOptions): string {
  const runner = Buffer.from(RUNNER_SOURCE, 'utf8').toString('base64')
  return [
    `FROM ${BUN_IMAGE} AS build`,
    'WORKDIR /src',
    'COPY . .',
    '# Their dependencies, if they have any. A worker with no imports beyond',
    '# the runtime has no package.json and must still build, so a failed or',
    '# absent install is not fatal here: the bundle step below is what decides',
    '# whether the code is actually buildable.',
    'RUN bun install --frozen-lockfile 2>/dev/null || bun install 2>/dev/null || true',
    '# Bundled for workerd, not for Bun or Node: the `workerd` condition is',
    '# what makes packages that ship a Workers-specific entry point resolve to',
    '# it, and `browser` is the target Cloudflare\'s own tooling uses because a',
    '# Worker has no filesystem and no node builtins by default.',
    '# `cloudflare:*` is provided BY workerd at runtime and must not be bundled.',
    '# Without this, `import { DurableObject } from "cloudflare:workers"`, which',
    '# is the documented way to write a Durable Object and what every current',
    '# Cloudflare example uses, fails the build outright:',
    '#',
    '#   error: Could not resolve: "cloudflare:workers". Maybe you need to "bun install"?',
    '#',
    '# Found by deploying one (docs/durable-objects/research/2026-08-11-end-to-end-alarm-across-sleep.md).',
    '# The failure is at build time with a message about installing a package,',
    '# so it reads like the user got their imports wrong rather than like a',
    '# platform that cannot run the syntax its own docs are written in.',
    `RUN bun build ${JSON.stringify(opts.main)} --outfile /out/worker.mjs --target=browser --format=esm --conditions=workerd,worker,browser --external ${JSON.stringify('cloudflare:*')}`,
    '',
    `FROM ${NODE_IMAGE}`,
    `RUN mkdir -p ${CONTAINER_ROOT} ${CONTAINER_STATE} ${CONTAINER_DO}`,
    `WORKDIR ${CONTAINER_ROOT}`,
    '# Installed before the bundle is copied in, so a change to the user\'s',
    '# code does not reinstall miniflare (and with it the workerd binary,',
    '# which is not small).',
    `RUN npm install --omit=dev --no-audit --no-fund miniflare@${MINIFLARE_VERSION}`,
    `RUN echo '${runner}' | base64 -d > ${CONTAINER_ROOT}/runner.mjs`,
    `COPY --from=build /out/worker.mjs ${CONTAINER_ROOT}/worker.mjs`,
    'ENV NODE_ENV=production',
    `CMD ["node", "${CONTAINER_ROOT}/runner.mjs"]`,
    '',
  ].join('\n')
}

export interface BuildWorkerImageOptions {
  contextPath: string
  dockerfilePath: string
  tag: string
  memory?: string
  cpuShares?: number
}

export async function buildWorkerImage(
  runtime: ComputeRuntime,
  opts: BuildWorkerImageOptions
): Promise<string> {
  if (runtime.build === undefined) {
    throw new HobbyError(
      'runtime_unavailable',
      'this compute runtime cannot build images',
      'the worker kind needs a runtime that implements ComputeRuntime.build'
    )
  }
  const spec: BuildSpec = {
    contextPath: opts.contextPath,
    dockerfile: opts.dockerfilePath,
    tag: opts.tag,
    ...(opts.memory === undefined ? {} : { memory: opts.memory }),
    ...(opts.cpuShares === undefined ? {} : { cpuShares: opts.cpuShares }),
  }
  return runtime.build(spec)
}
