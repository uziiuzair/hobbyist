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

// The process inside the container. Reads its whole configuration from one
// environment variable, so nothing about a specific worker is baked into the
// image beyond its own bundled code.
//
// Kept as a string rather than a file in this package because it has to be
// embedded in a generated Dockerfile, and a second copy on disk that could
// drift from this one is worse than a template literal.
export const RUNNER_SOURCE = `import { Miniflare } from 'miniflare'

const raw = process.env.HOBBY_WORKER_MANIFEST
if (!raw) {
  console.error('hobby: HOBBY_WORKER_MANIFEST is not set; nothing to run')
  process.exit(1)
}
const manifest = JSON.parse(raw)

const mf = new Miniflare({
  modules: true,
  scriptPath: '${CONTAINER_ROOT}/worker.mjs',
  compatibilityDate: manifest.compatibilityDate,
  compatibilityFlags: manifest.compatibilityFlags ?? [],
  bindings: manifest.vars ?? {},
  kvNamespaces: manifest.kvNamespaces ?? [],
  r2Buckets: manifest.r2Buckets ?? [],
  d1Databases: manifest.d1Databases ?? [],
  queueProducers: manifest.queueProducers ?? [],
  queueConsumers: manifest.queueConsumers ?? [],
  durableObjects: manifest.durableObjects ?? {},
  ...(manifest.hyperdrives ? { hyperdrives: manifest.hyperdrives } : {}),
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

// A clean shutdown, so a sleep does not look like a crash to whatever the
// worker was talking to, and so Durable Object storage is flushed rather
// than recovered on the next wake.
const shutdown = async () => {
  try {
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
