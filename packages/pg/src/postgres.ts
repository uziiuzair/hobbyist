// The postgres resource kind: create, start, stop, destroy. This is the
// only place in the package that touches the store and the compute runtime
// together; readiness.ts and connstring.ts are pure helpers this file calls.

import { randomBytes } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import {
  HobbyError,
  validateName,
  type ActivitySink,
  type ComputeRuntime,
  type ContainerSpec,
  type HobbyConfig,
  type Paths,
  type PostgresConfig,
  type Project,
  type Resource,
  type Store,
} from '@hobby.sh/core'
import { pgProbe, waitReady } from './readiness.js'

export interface PgDeps {
  store: Store
  runtime: ComputeRuntime
  paths: Paths
  config: HobbyConfig
  // Where "this resource just became usable / stopped being usable" is
  // reported. Optional so a caller building a PgDeps from just
  // { store, runtime, paths, config } still satisfies this interface; the
  // daemon always supplies one, because DaemonContext's own `activity`
  // field (the proxy's ActivityTracker) structurally is an ActivitySink.
  // These two calls are what make hibernation honest for a resource woken
  // by `hobby wake` or Studio rather than by a proxy connection: without
  // them the tracker never hears about it, idleSeconds stays null, and the
  // hibernator skips it forever. See core's ActivitySink.
  activity?: ActivitySink
  // Optional seam for tests. Defaults to pgProbe, which opens a real `pg`
  // connection against the allocated host port. There is no other way to
  // exercise createPostgres/startPostgres against createFakeRuntime, which
  // never has an actual Postgres listening on that port: without this, the
  // readiness wait inside createPostgres would always run out its full
  // timeout and land the resource in `failed`, not `sleeping`. Additive and
  // optional, so any caller building a PgDeps from just
  // { store, runtime, paths, config } still satisfies this interface.
  probeFactory?: (config: PostgresConfig) => () => Promise<boolean>
  // Optional seam for tests. Defaults to fs.rm(path, { recursive: true,
  // force: true }). destroyPostgres needs to be tested against a rm that
  // genuinely fails (a busy disk, a permission error) to pin down that a
  // real failure is collected and thrown rather than swallowed; forcing a
  // real fs.rm to fail deterministically would mean relying on OS-level
  // permission tricks, which is fragile and platform-dependent. Additive
  // and optional, same reasoning as probeFactory above.
  removeDataDir?: (path: string) => Promise<void>
}

const SUPERUSER = 'postgres'
const POSTGRES_CONTAINER_PORT = 5432
// Not PGDATA itself. PostgreSQL 18's official image refuses to start when a
// bind mount lands directly at /var/lib/postgresql/data (exit 1, log says to
// mount the home directory instead); the entrypoint then places the real
// data directory at <mount>/18/docker. See docs/decisions/0003's 2026-08-07
// amendment and core's resolvePgdataPath, which derives that subdirectory
// for anyone who needs the true on-disk PGDATA rather than this mount point.
const POSTGRES_HOME_CONTAINER_PATH = '/var/lib/postgresql'

// Wide open on purpose: leaves headroom below the well-known port range and
// clear of the daemon's own ports (proxyPort 5432, studioPort 8443, apiPort
// 7432 from HobbyConfig's defaults).
const PORT_RANGE_FROM = 15432
const PORT_RANGE_TO = 25432

// 16 random bytes as hex is exactly 32 characters, matching the brief's "32
// character random password" precisely rather than approximately (base64
// would need padding trimmed to hit 32 exactly; hex does not).
const PASSWORD_BYTES = 16

// Always a clean stop, on a timeout, never a kill: see docker.ts's own
// comment on why a SIGKILLed Postgres pays for crash recovery on the next
// wake, inside a user's first query.
const STOP_TIMEOUT_SEC = 30

function containerSpec(config: PostgresConfig, network: string): ContainerSpec {
  return {
    name: config.containerName,
    image: config.image,
    env: {
      POSTGRES_PASSWORD: config.password,
      POSTGRES_USER: config.superuser,
      // The database inside is named after the project, not `postgres`,
      // because the proxy routes on the database name a client sends in its
      // startup packet (see core's parseRoutingKey). POSTGRES_DB is what
      // makes the official image's entrypoint create it on first boot.
      POSTGRES_DB: config.database,
    },
    ports: [{ host: config.hostPort, container: POSTGRES_CONTAINER_PORT }],
    binds: [{ host: config.dataDir, container: POSTGRES_HOME_CONTAINER_PATH }],
    network,
  }
}

export async function createPostgres(
  deps: PgDeps,
  opts: { project: Project; name: string }
): Promise<Resource> {
  validateName(opts.name)

  const hostPort = deps.store.allocatePort(PORT_RANGE_FROM, PORT_RANGE_TO)
  const password = randomBytes(PASSWORD_BYTES).toString('hex')
  const containerName = `hobby-${opts.project.name}-${opts.name}`
  const dataDir = deps.paths.resourceDataDir(opts.project.name, opts.name)

  const config: PostgresConfig = {
    image: deps.config.image,
    containerName,
    dataDir,
    hostPort,
    superuser: SUPERUSER,
    password,
    database: opts.project.name,
  }

  const resource = deps.store.createResource({
    projectId: opts.project.id,
    kind: 'postgres',
    name: opts.name,
    config,
  })

  try {
    // Deliberately no --user on the container we are about to create (see
    // containerSpec / ContainerSpec: there is no such field, and that is not
    // an oversight). The data directory below is created by this process, so
    // it is owned by whoever is running the daemon, while Postgres inside
    // the container runs as its own uid. The official image's entrypoint
    // only chowns PGDATA to that uid when it starts as root; passing --user
    // would skip that chown and turn first boot into a permission-denied
    // failure on Linux, while looking fine on macOS, where Docker Desktop's
    // VM masks host/container uid mismatches. Mode 0700 plus no --user is
    // what lets the entrypoint take ownership correctly on first boot.
    await mkdir(dataDir, { recursive: true, mode: 0o700 })

    await deps.runtime.ensureNetwork(opts.project.networkName)
    await deps.runtime.ensureCreated(containerSpec(config, opts.project.networkName))
    await deps.runtime.start(containerName)

    const probe = (deps.probeFactory ?? pgProbe)(config)
    const result = await waitReady({
      config,
      pollMs: deps.config.readinessPollMs,
      timeoutMs: deps.config.wakeTimeoutMs,
      probe,
    })

    if (!result.ready) {
      deps.store.setResourceState(resource.id, 'failed')
      throw new HobbyError(
        'wake_failed',
        `postgres for ${opts.project.name}/${opts.name} did not become ready during initial boot`,
        `waited ${result.waitedMs}ms across ${result.attempts} attempts`
      )
    }

    // Boot once so initdb and CREATE DATABASE happen, then stop cleanly.
    // Sleeping, not running, is the correct resting state for a system whose
    // entire premise is sleep: a clean stop here is what keeps the *next*
    // start out of crash recovery.
    await deps.runtime.stop(containerName, { timeoutSec: STOP_TIMEOUT_SEC })
    deps.store.setResourceState(resource.id, 'sleeping')
  } catch (err) {
    // The wake_failed branch above already recorded `failed`; every other
    // failure path here (mkdir, ensureNetwork, ensureCreated, start, the
    // final stop) still needs the row to reflect that creation did not
    // finish cleanly, so it does not read as `creating` forever.
    if (!(err instanceof HobbyError && err.code === 'wake_failed')) {
      deps.store.setResourceState(resource.id, 'failed')
    }
    throw err
  }

  const final = deps.store.getResource(resource.id)
  if (final === null) {
    throw new HobbyError('internal', `resource ${resource.id} vanished immediately after creation`)
  }
  return final
}

export async function startPostgres(deps: PgDeps, resource: Resource): Promise<void> {
  deps.store.setResourceState(resource.id, 'starting')

  // A `starting` (or, in stopPostgres below, `stopping`) state that outlives
  // the operation that set it is a lie the reconcile and hibernation tasks
  // will believe. Any throw here, not just a failed readiness wait, must
  // record `failed` before propagating.
  try {
    await deps.runtime.start(resource.config.containerName)
  } catch (err) {
    deps.store.setResourceState(resource.id, 'failed')
    throw err
  }

  const probe = (deps.probeFactory ?? pgProbe)(resource.config)
  const result = await waitReady({
    config: resource.config,
    pollMs: deps.config.readinessPollMs,
    timeoutMs: deps.config.wakeTimeoutMs,
    probe,
  })

  if (!result.ready) {
    deps.store.setResourceState(resource.id, 'failed')
    throw new HobbyError(
      'wake_timeout',
      `postgres for resource ${resource.id} did not become ready within ${deps.config.wakeTimeoutMs}ms`,
      `waited ${result.waitedMs}ms across ${result.attempts} attempts`
    )
  }

  deps.store.setResourceState(resource.id, 'running')
  deps.store.touchResource(resource.id, new Date())
  // The resource is usable as of right now, whoever asked for it: a proxy
  // connection, `hobby wake`, or Studio. The idle clock has to start here,
  // not only when a proxy connection later closes, or a resource woken from
  // the CLI or Studio would have no idle clock at all and would never sleep.
  deps.activity?.touch(resource.id)
}

export async function stopPostgres(deps: PgDeps, resource: Resource): Promise<void> {
  deps.store.setResourceState(resource.id, 'stopping')
  try {
    await deps.runtime.stop(resource.config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
  } catch (err) {
    deps.store.setResourceState(resource.id, 'failed')
    throw err
  }
  deps.store.setResourceState(resource.id, 'sleeping')
  // The connection count and idle clock described a container that is now
  // stopped. Carrying them forward is what made a resource woken a moment
  // later get slept again on the very next tick, on an idle time measured
  // against the previous run.
  deps.activity?.reset(resource.id)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function defaultRemoveDataDir(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

// Teardown is best-effort and resilient step by step: a resource can reach
// this function having never had a container created at all (e.g.
// createPostgres failed at mkdir or ensureNetwork, before ensureCreated
// ever ran). A missing container or a missing data directory is not a
// failure: runtime.stop()/remove() both resolve as no-ops for a container
// that is already gone (see docker.ts), and rm's force: true already
// swallows "does not exist." A single failing step must not prevent the
// remaining steps from running, and the row must always be deleted last:
// it is the source of truth for "this resource exists," and a `failed` row
// with nothing left to tear down would otherwise be permanently stuck with
// no path to remove it.
//
// But an actual failure (the Docker daemon unreachable, an `rm` blocked by
// permissions or a busy disk) is a different thing entirely, and must not
// be discarded: deleting the row while quietly leaving a container or data
// directory behind would tell the caller their data is gone when it may
// still be sitting on disk. So each step's real failure is collected, not
// swallowed; the row is still deleted unconditionally (the record must not
// survive); and only then, if anything failed, is a single error thrown
// that names every step that did and says plainly that something may
// remain on disk. Deleting the row first and throwing second is
// deliberate, in that order.
export async function destroyPostgres(deps: PgDeps, resource: Resource): Promise<void> {
  const failures: string[] = []

  try {
    await deps.runtime.stop(resource.config.containerName, { timeoutSec: STOP_TIMEOUT_SEC })
  } catch (err) {
    failures.push(`stop container: ${errorMessage(err)}`)
  }

  try {
    await deps.runtime.remove(resource.config.containerName)
  } catch (err) {
    failures.push(`remove container: ${errorMessage(err)}`)
  }

  const removeDataDir = deps.removeDataDir ?? defaultRemoveDataDir
  try {
    await removeDataDir(resource.config.dataDir)
  } catch (err) {
    failures.push(`remove data directory: ${errorMessage(err)}`)
  }

  deps.store.deleteResource(resource.id)
  // Same reasoning as stopPostgres, one step further: there is not even a
  // resource left for this activity to describe, and without this the
  // tracker would keep an entry for every resource ever destroyed.
  deps.activity?.reset(resource.id)

  if (failures.length > 0) {
    throw new HobbyError(
      'internal',
      `resource ${resource.id} is no longer managed, but ${failures.length} teardown step(s) failed: ${failures.join('; ')}`,
      'a container or the data directory may still remain on disk and may need manual cleanup'
    )
  }
}
