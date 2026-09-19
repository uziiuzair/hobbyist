// DaemonContext is the one piece of shared state every route handler,
// reconcile, and shutdown read and write. It is built once, outside this
// file (by whatever process starts the daemon), and threaded through
// createApp and startDaemon. It is also, structurally, a superset of
// @hobby.sh/pg's PgDeps: store, runtime, paths and config are the same four
// required fields, so a DaemonContext can be passed straight into
// createPostgres/startPostgres/stopPostgres/destroyPostgres without any
// adapting. The extra `activity` field they ignore is exactly what makes
// this a daemon context rather than just a PgDeps.
//
// Constructing an ActivityTracker is the daemon's job, not the proxy's: see
// packages/proxy/src/activity.ts's own file comment. Task 7 wires this same
// instance into ProxyDeps when it starts the wake-on-connect proxy; nothing
// here starts that proxy, see the task report for why that split is
// deliberate.

import {
  createDockerRuntime,
  createKindRegistry,
  HobbyError,
  openStore,
  type ComputeRuntime,
  type HobbyConfig,
  type KindRegistry,
  type Paths,
  type PostgresConfig,
  type PostgresResource,
  type Store,
} from '@hobby.sh/core'
import { appKindHandler } from '@hobby.sh/app'
import { postgresKindHandler, type ProbeOutcome } from '@hobby.sh/pg'
import { queueKindHandler } from '@hobby.sh/queue'
import { workerKindHandler } from '@hobby.sh/worker'
import {
  ActivityTracker,
  type HttpProxyDeps,
  type HttpTarget,
  type ProxyDeps,
  type ProxyTarget,
} from '@hobby.sh/proxy'
import { createTailnetDetector } from './tailnet.js'
import { formatRetryDelay, redactWakeError, wakeRetryDelayMs } from './wake-backoff.js'

// Every kind this daemon knows how to run. One list, built here, read by
// every dispatch site (routes, hibernator, reconcile, the wake path). Adding
// a kind is adding a line here plus its package; nothing else in the daemon
// learns a new name. That is what ADR 0007's "later kinds are registered by
// implementing an interface, and earlier phases do not change" buys.
export function createDefaultKindRegistry(): KindRegistry {
  return createKindRegistry([postgresKindHandler, appKindHandler, workerKindHandler, queueKindHandler])
}

export interface DaemonContext {
  store: Store
  runtime: ComputeRuntime
  paths: Paths
  config: HobbyConfig
  activity: ActivityTracker
  kinds: KindRegistry
  // Optional test seam, identical in shape and reasoning to
  // PgDeps.probeFactory (packages/pg/src/postgres.ts) and read by exactly
  // that code, since a DaemonContext structurally IS a PgDeps. Declaring it
  // here is what lets a daemon-level test (routes, hibernator, reconcile)
  // simulate a Postgres that genuinely answers, rather than having every
  // wake run out its readiness timeout against a fake runtime with nothing
  // listening. reconcile.ts reads the same field for its own readiness
  // probe. Production never sets it and gets pgProbe, a real connection.
  probeFactory?: (config: PostgresConfig) => () => Promise<ProbeOutcome>
  // Set by startDaemon once the queue endpoint is listening, so that creating
  // a project can bind that project's bridge gateway immediately rather than
  // leaving it until the next daemon restart. Optional because a test builds a
  // context with no endpoint at all, and because the CLI's own local commands
  // construct one to talk to the store without ever serving anything.
  //
  // The gap this closes is measured in
  // docs/queues/research/2026-08-22-the-producer-path-on-real-linux.md.
  onProjectNetworkCreated?: (gateway: string) => Promise<void>
  // Same polarity as probeFactory, inverted purpose: production sets it
  // (createDaemonContext wires the real `tailscale status --json` probe,
  // see tailnet.ts) and tests either leave it unset, getting a
  // deterministic null with no binary executed, or set a fake. Returns the
  // box's MagicDNS name when a tailnet is up, null otherwise.
  detectTailnet?: () => Promise<string | null>
  // The clock the wake refusal reads (buildWake below): when a failed wake
  // happened, and whether its retry time has passed. A test seam of the same
  // kind as probeFactory, so the backoff schedule is tested by moving a
  // number instead of sleeping through 30 seconds, then a minute, then two.
  // Production leaves it unset and gets Date.now.
  //
  // Named wakeClock and not `now`, for the reason AppDeps.appProbeFactory
  // (packages/app/src/app.ts) gives for its own name: a DaemonContext is
  // passed structurally as every kind's deps, and AppDeps and WorkerDeps
  // already read a field called `now`, to name an image tag. A fake clock
  // set here for the refusal must not also rename every image a test builds.
  wakeClock?: () => number
}

// A convenience factory for the real, production wiring: opens the real
// sqlite store at paths.statePath and talks to the real Docker daemon.
// Entirely optional. Tests build a DaemonContext by hand, from a fake
// runtime and an in-memory store, and never call this. Whatever eventually
// implements `hobby init` (not built in this task) is the intended caller.
export function createDaemonContext(opts: {
  paths: Paths
  config: HobbyConfig
  runtime?: ComputeRuntime
}): DaemonContext {
  return {
    store: openStore(opts.paths.statePath),
    runtime: opts.runtime ?? createDockerRuntime(),
    paths: opts.paths,
    config: opts.config,
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
    detectTailnet: createTailnetDetector(),
  }
}

// The one real, idempotent wake function for a given DaemonContext:
// concurrent callers for the same resourceId all await the same in-flight
// startPostgres call, tracked in a Map private to this closure. The proxy
// itself deliberately does not de-duplicate concurrent wakes for the same
// resource (see packages/proxy/src/proxy.ts's own comment on
// ProxyDeps.wake); this is what turns ten simultaneous connections to one
// sleeping resource into exactly one startPostgres call, with every caller
// awaiting the same promise. The entry is removed in a `finally` on both
// success and failure, so one failed wake does not permanently poison the
// in-flight map for every connection after it.
//
// What does stop the next connection is the refusal map below. A wake
// through this function whose kind handler throws (a container that will not
// start, a readiness wait that timed out, a Postgres that refused its probe
// with a real error) records the resource id there with a retry time, and
// every automatic wake of that id before the retry time is refused before
// the kind handler is reached. Without it, a resource whose boot reliably
// fails got a fresh container start per incoming connection, forever: a
// monitoring check or an ORM pool retrying once a second turned one broken
// database into a crash loop driven by traffic (issue #10). The
// de-duplication above only bounds starts to one per *concurrent* burst;
// this bounds them across bursts, including for the implicit wakers with no
// front door (the alarm mirror, Studio's query route).
//
// The refusal ends by itself. After the Nth consecutive failure the retry
// time is the failure plus wakeRetryDelayMs(N) (packages/cli/src/daemon/wake-backoff.ts):
// 30 seconds, doubling to a 15 minute cap. Once it passes, the next
// automatic wake is let through to the kind handler, exactly once: every
// caller arriving while that attempt runs joins it through inFlightWakes
// above, so a crowd of clients that were all waiting for the retry time
// costs one start, not one each. A failure there moves the retry time out
// again, one step further along the schedule; a success deletes the entry,
// so the next failure, whenever it comes, starts again at 30 seconds. The
// first cut of issue #10 refused until someone ran `hobby wake`, and that
// was the wrong default for the failures a small box actually has: a disk
// briefly full, Docker restarting, a slow first boot after a host reboot.
// Each of those clears on its own, and each left a database refused for as
// long as it took a human to notice, with nothing but error text in some
// application's log to notice it by. The bound issue #10 needed is still
// here, it is just a rate now rather than a stop: a resource that never
// boots costs a few starts in its first quarter of an hour and four an hour
// after that, however many clients keep connecting.
//
// Why a map of failed wakes and not the store's `failed` state: `failed` is
// the label reconcile (packages/cli/src/daemon/reconcile.ts, correctedState)
// writes for a resource recorded running whose container is found stopped,
// which is every unclean host reboot, OOM kill or crash. Those databases are
// perfectly wakeable (Postgres runs crash recovery on start), and refusing on
// the label would leave every one of them down after a reboot until someone
// ran `hobby wake` by hand. A failed stop or a failed deploy writes `failed`
// too, and neither says anything about whether the next start would work.
// So `failed` keeps meaning what reconcile and the handlers say it means, and
// "refused" means something narrower: a wake failed recently, since this
// daemon started, and its retry time has not come yet.
//
// The map is in memory on purpose. A daemon restart empties it, which allows
// one fresh attempt per daemon lifetime on top of the schedule: still
// bounded, and what an operator expects after an upgrade. The explicit way
// to retry now is POST /v1/resources/:id/start (startResourceRoute in
// routes.ts, behind `hobby wake`, the MCP wake tool and Studio's start
// button), which calls clearWakeRefusal before invoking the kind handler
// directly, not this function, so it is never refused. What is refused, and
// until when, is readable through getWakeRefusal, which is how `hobby ls`
// and every other client of toWireResource (packages/cli/src/daemon/wire.ts)
// show it.
function buildWake(ctx: DaemonContext): (resourceId: string) => Promise<void> {
  const inFlightWakes = new Map<string, Promise<void>>()
  const refusals = wakeRefusals(ctx)
  const now = ctx.wakeClock ?? Date.now

  return function wake(resourceId: string): Promise<void> {
    const existing = inFlightWakes.get(resourceId)
    if (existing !== undefined) {
      return existing
    }

    const promise = (async (): Promise<void> => {
      let resource = ctx.store.getResource(resourceId)
      if (resource === null) {
        throw new HobbyError('resource_not_found', `no resource with id ${resourceId}`)
      }
      const refusal = refusals.get(resourceId)
      const checkedAt = now()
      if (refusal !== undefined && checkedAt < refusal.retryAt) {
        const project = ctx.store.getProject(resource.projectId)
        throw refusedWakeError(project === null ? resource.name : `${project.name}/${resource.name}`, refusal, checkedAt)
      }
      // A snapshot or an in-place restore holds this project asleep (see
      // holdProjectAsleep below). Waking a resource in the middle of one is
      // not a slow path, it is the failure ADR 0016 is built to prevent: a
      // clone of a PGDATA that a freshly started postgres is writing to, filed
      // as a good snapshot. Waiting rather than refusing keeps the wedge's
      // promise, a first query that is slow rather than one that errors, and
      // the snapshot's own resume has usually started the resource again by
      // the time the wait ends, which is why the row is read a second time.
      const fence = projectFences.get(ctx)?.get(resource.projectId)
      if (fence !== undefined) {
        await fence
        resource = ctx.store.getResource(resourceId)
        if (resource === null) {
          throw new HobbyError('resource_not_found', `no resource with id ${resourceId}`)
        }
        if (resource.state === 'running') {
          // Running is as good as a successful wake for the refusal's
          // purposes: whatever failed before evidently no longer does.
          refusals.delete(resourceId)
          return
        }
      }
      // Dispatched by kind rather than calling startPostgres directly, which
      // is what makes this one wake path serve every kind: an app waking on
      // an HTTP request and a database waking on a connection are the same
      // call here, differing only in which handler answers it.
      try {
        await ctx.kinds.get(resource.kind).start(ctx, resource)
      } catch (err) {
        // Counted from the entry as it stands now, not the one read above:
        // an explicit start may have cleared it while this attempt ran, and
        // a failure after someone deliberately reset the count is the first
        // of a new run, not the next of the old one. The retry time is
        // measured from the failure, not from when the attempt began,
        // because a start that failed by timing out has already spent
        // wakeTimeoutMs, and measuring from its beginning would give it a
        // shorter rest than a start that failed at once.
        const failures = (refusals.get(resourceId)?.failures ?? 0) + 1
        refusals.set(resourceId, {
          failures,
          retryAt: now() + wakeRetryDelayMs(failures),
          lastError: redactWakeError(err instanceof Error ? err.message : String(err)),
        })
        throw err
      }
      refusals.delete(resourceId)
    })().finally(() => {
      inFlightWakes.delete(resourceId)
    })

    inFlightWakes.set(resourceId, promise)
    return promise
  }
}

// The refusal buildWake throws for a resource whose retry time has not come.
// The command is in the message and not only the hint because the HTTP
// router renders err.message alone (http.ts's resolveAndWake; errorMessage in
// packages/proxy/src/proxy.ts shows the hint too). The retry time is in the
// message for the same reason: whoever reads this in an application's log
// needs to know whether waiting is enough, and it is, if the cause was
// transient. Both the relative and the absolute time are given because a log
// line is often read long after it was written, when "another 4m 0s" alone
// no longer means anything.
function refusedWakeError(target: string, refusal: WakeRefusal, now: number): HobbyError {
  const times = refusal.failures === 1 ? 'failed' : `failed ${refusal.failures} times in a row`
  return new HobbyError(
    'wake_failed',
    `a wake of ${target} ${times}, so it is not woken automatically for another ${formatRetryDelay(refusal.retryAt - now)} (until ${new Date(refusal.retryAt).toISOString()}); fix the cause and wait, or run \`hobby wake ${target}\` to retry it now`,
    `the last start failed with: ${refusal.lastError}; \`hobby logs ${target}\` shows what it printed`
  )
}

// One entry per resource whose most recent wake through buildWake failed.
// failures counts consecutive failed wakes (a success deletes the entry, so
// the count restarts); retryAt is epoch milliseconds, the first moment an
// automatic wake is let through again; lastError is the failed start's own
// message, passed through redactWakeError (packages/cli/src/daemon/wake-backoff.ts)
// because it is repeated on the wire for as long as the entry lives.
export interface WakeRefusal {
  failures: number
  retryAt: number
  lastError: string
}

const refusalRegistry = new WeakMap<DaemonContext, Map<string, WakeRefusal>>()

// One map per DaemonContext (so per daemon lifetime, and per test). See
// buildWake's comment for why this, and not the store's `failed` state, is
// what refuses.
function wakeRefusals(ctx: DaemonContext): Map<string, WakeRefusal> {
  let map = refusalRegistry.get(ctx)
  if (map === undefined) {
    map = new Map()
    refusalRegistry.set(ctx, map)
  }
  return map
}

// Read by both front doors (ProxyDeps.isWakeRefused, HttpProxyDeps.isWakeRefused)
// so a refused client gets its answer with no wake call and no dial. False
// once the retry time has passed, even though the entry is still there: that
// is what lets the next connection through to make the one retry attempt,
// and buildWake applies the same comparison, against the same clock, when it
// is reached.
export function isWakeRefused(ctx: DaemonContext, resourceId: string): boolean {
  const refusal = wakeRefusals(ctx).get(resourceId)
  return refusal !== undefined && (ctx.wakeClock ?? Date.now)() < refusal.retryAt
}

// The entry itself, for display (toWireResource in packages/cli/src/daemon/wire.ts).
// Returned whether or not its retry time has passed: a resource that failed
// three times and is waiting for its next connection to be retried is worth
// showing, and a retryAt in the past is how a reader tells that apart from
// one that is still refusing. A copy, so a caller cannot edit the schedule.
export function getWakeRefusal(ctx: DaemonContext, resourceId: string): WakeRefusal | null {
  const refusal = wakeRefusals(ctx).get(resourceId)
  return refusal === undefined ? null : { ...refusal }
}

// The explicit clear: called by startResourceRoute before it starts the
// resource, which is what `hobby wake` means. Resets the count as well as
// the retry time, so a failure after it starts the schedule from 30 seconds.
export function clearWakeRefusal(ctx: DaemonContext, resourceId: string): void {
  wakeRefusals(ctx).delete(resourceId)
}

const wakeRegistry = new WeakMap<DaemonContext, (resourceId: string) => Promise<void>>()

// Per-context, keyed by project id: a promise that settles when the project
// may be woken again. Same WeakMap-per-context shape as wakeRegistry above,
// for the same reason (one daemon, one map; every test's fresh ctx gets its
// own). A module value rather than a DaemonContext field so that the dozens
// of hand-built contexts across the test suites do not all have to learn
// about it.
const projectFences = new WeakMap<DaemonContext, Map<string, Promise<void>>>()

// Holds every resource in a project asleep against the wake path until the
// returned release function is called. quiesce
// (packages/cli/src/daemon/snapshots.ts) stops what is running, but stopping
// is not enough on its own: the proxy wakes anything a client connects to,
// and an application's connection pool reconnects the instant quiesce drops
// its connections. The activity guard passes a pool that is connected and
// idle, so the most ordinary install there is (an app with a pool pointed at
// its database) would otherwise get its database woken back up in the middle
// of the clone that was meant to be of a stopped one.
//
// A second hold on the same project is refused outright rather than queued:
// two snapshots, or a snapshot and a restore, interleaving on one project
// means the first to finish resumes resources while the second is still
// copying them, and there is no ordering of the two that is safe.
//
// Covers getOrCreateWake (the Postgres proxy, the HTTP router and the query
// route all go through it) and startResourceRoute's explicit wake
// (packages/cli/src/daemon/routes.ts, through waitForProjectAwakeable
// below). It does not cover a queue's enqueue endpoint or delivery tick,
// which write messages.sqlite without waking anything; docs/backups/CLAUDE.md
// records that gap.
export function holdProjectAsleep(ctx: DaemonContext, projectId: string, projectName: string): () => void {
  let fences = projectFences.get(ctx)
  if (fences === undefined) {
    fences = new Map()
    projectFences.set(ctx, fences)
  }
  if (fences.has(projectId)) {
    throw new HobbyError(
      'conflict',
      `a snapshot or restore of ${projectName} is already in progress`,
      'wait for it to finish, then try again'
    )
  }
  let release: () => void = () => {}
  const fence = new Promise<void>((resolve) => {
    release = resolve
  })
  fences.set(projectId, fence)
  const held = fences
  return () => {
    if (held.get(projectId) === fence) {
      held.delete(projectId)
    }
    release()
  }
}

// For a caller that starts a resource without going through the wake
// function above (startResourceRoute): the same wait, and nothing else.
export async function waitForProjectAwakeable(ctx: DaemonContext, projectId: string): Promise<void> {
  const fence = projectFences.get(ctx)?.get(projectId)
  if (fence !== undefined) {
    await fence
  }
}

// Memoized per DaemonContext in a WeakMap, the same pattern
// studio/routes.ts uses for its own per-context session state: this is what
// lets createProxyDeps (below, the proxy's own caller) and
// packages/cli/src/daemon/routes.ts's queryRoute (POST
// /v1/resources/:id/query) share the exact same wake function, and the
// exact same in-flight map, whenever they are handed the same ctx, which in
// production they always are, one DaemonContext per running daemon. That is
// what makes the query route's wake genuinely "the same idempotent wake
// path the proxy uses" rather than a second, independent implementation of
// the same idea: a client connecting through the proxy and Studio calling
// the query route for the same sleeping resource at the same moment await
// the one real startPostgres call in flight, not two. A fresh ctx (every
// test's own buildContext()) gets its own independent function and map, so
// tests stay isolated from each other and from production.
export function getOrCreateWake(ctx: DaemonContext): (resourceId: string) => Promise<void> {
  let wake = wakeRegistry.get(ctx)
  if (wake === undefined) {
    wake = buildWake(ctx)
    wakeRegistry.set(ctx, wake)
  }
  return wake
}

// The real ProxyDeps the wake-on-connect proxy runs against, bound to this
// DaemonContext. Task 4 left this exact wiring as Task 7's to do (see
// task-4-report.md's "What Task 7 must wire"): resolve looks a project up
// by the routing key's project segment and returns its resource's running
// host, port and database; wake calls startPostgres, which already waits
// for real readiness before resolving, satisfying ProxyDeps.wake's
// contract that it must not resolve until Postgres is actually accepting
// connections.
export function createProxyDeps(ctx: DaemonContext): ProxyDeps {
  async function resolve(projectName: string): Promise<ProxyTarget | null> {
    const project = ctx.store.getProjectByName(projectName)
    if (project === null) {
      return null
    }

    // A released project is one hobby handed over: its data directory now
    // belongs to whatever the user started from the emitted compose file.
    // Waking it here would open a second postgres on that same PGDATA, which
    // is not a conflict the user gets an error about, it is corruption. The
    // rows are all still here, which is why this is a refusal with a reason
    // rather than a "no such project".
    if (project.releasedAt != null) {
      throw new HobbyError(
        'conflict',
        `project ${projectName} was released and is no longer managed by hobby`,
        'it is running from the compose file hobby eject --release gave you. Run `hobby adopt ' +
          projectName +
          '` to take it back, after stopping that stack.'
      )
    }

    // Only postgres resources are candidates. Port 5432 speaks one protocol
    // and a startup packet cannot name an app or a worker, so a project
    // holding a database and two apps must still route cleanly to the
    // database rather than reading as ambiguous. Filtering by kind here,
    // before the count checks below, is what keeps that true: without it,
    // deploying an app to a project would have broken psql against its
    // database, which is exactly the kind of cross-phase breakage ADR 0007
    // guard 1 exists to prevent.
    const resources = ctx.store.listResources(project.id).filter((r) => r.kind === 'postgres')
    if (resources.length === 0) {
      return null
    }
    if (resources.length > 1) {
      // The wire protocol's routing key (core's parseRoutingKey) carries a
      // project and, optionally, a database, never a resource name: there
      // is nothing in a Postgres startup packet that can disambiguate which
      // of several resources under one project a client means. The CLI's
      // own resolveTarget (packages/cli/src/cli/commands.ts) hits the same
      // ambiguity for `project/resource` targets and throws the same code;
      // matching it here keeps one error identity for "this project needs a
      // specific resource named" across both surfaces. proxy.ts's own
      // try/catch around deps.resolve turns this into a FATAL error on the
      // wire rather than crashing the connection handler.
      throw new HobbyError(
        'ambiguous_target',
        `project ${projectName} has more than one postgres resource: ${resources.map((r) => r.name).join(', ')}`,
        'the wake-on-connect proxy cannot disambiguate resources by database name alone; connect to a project with exactly one postgres resource'
      )
    }

    const resource = resources[0] as PostgresResource
    return {
      resourceId: resource.id,
      host: '127.0.0.1',
      port: resource.config.hostPort,
      state: resource.state,
      database: resource.config.database,
    }
  }

  return {
    resolve,
    wake: getOrCreateWake(ctx),
    isWakeRefused: (resourceId: string) => isWakeRefused(ctx, resourceId),
    activity: ctx.activity,
  }
}

// `<resource>.<project>.<domain>` split back into its two names.
//
// Exactly two labels ahead of the domain, never a wildcard match on the
// leftmost label alone: `a.b.c.blog.localhost` must not resolve to project
// `blog`, because accepting extra labels would let one deployed app be
// reached under names that look like other people's subdomains.
//
// Exported for its own tests: this is pure string handling with no store, no
// clock and no I/O, and it is the one place a hostname becomes a routing
// decision.
export function parseAppHostname(
  hostname: string,
  domain: string
): { project: string; resource: string } | null {
  const suffix = `.${domain.toLowerCase()}`
  const lower = hostname.toLowerCase()
  if (!lower.endsWith(suffix) || lower.length === suffix.length) {
    return null
  }
  const labels = lower.slice(0, -suffix.length).split('.')
  if (labels.length !== 2) {
    return null
  }
  const [resource, project] = labels
  if (resource === undefined || project === undefined || resource === '' || project === '') {
    return null
  }
  return { project, resource }
}

// The HTTP wake router's view of the world, bound to this DaemonContext.
// Mirrors createProxyDeps above: resolve reads the store, wake is the same
// memoized, de-duplicated wake the Postgres proxy and the query route
// already share, and activity is the same tracker hibernation reads. One
// wake path for every kind and every protocol is the point.
export function createHttpProxyDeps(ctx: DaemonContext): HttpProxyDeps {
  async function resolve(hostname: string): Promise<HttpTarget | null> {
    const parsed = parseAppHostname(hostname, ctx.config.domain)
    if (parsed === null) {
      return null
    }
    const project = ctx.store.getProjectByName(parsed.project)
    if (project === null) {
      return null
    }

    // Same refusal as the Postgres proxy's, for the same reason: a released
    // project's containers belong to the user's own compose stack now, and
    // waking one here would start a second copy of something already
    // running. Thrown rather than returned as null so the router can render
    // 503 with this reason rather than a bare 404, which would read as "you
    // never deployed this".
    if (project.releasedAt != null) {
      throw new HobbyError(
        'conflict',
        `project ${parsed.project} was released and is no longer managed by hobby`,
        `run \`hobby adopt ${parsed.project}\` to take it back`
      )
    }

    const resource = ctx.store.getResourceByName(project.id, parsed.resource)
    if (resource === null) {
      return null
    }
    // Only compute kinds serve HTTP. A postgres resource has a hostname
    // shaped like this one by accident of the naming scheme, and routing a
    // browser to port 5432 would hand it a Postgres wire protocol error.
    if (resource.kind !== 'app' && resource.kind !== 'worker') {
      return null
    }

    // Same shape as the released-project refusal just above: thrown, not
    // returned as null. Returning null renders 404 "nothing is deployed at
    // this hostname" (packages/proxy/src/http.ts:242), which is false here.
    // Something IS at this hostname: a row exists, it was created
    // deliberately (Task 4's createAppResource / createWorkerResource), and
    // it owns the name. Throwing renders 503 with this message
    // (packages/proxy/src/http.ts:246), and leaves allowHostname's catch
    // below free to still return true so a certificate can be issued before
    // any code ships.
    //
    // The whole sentence, command included, lives in the message argument
    // because resolveAndWake reads err.message alone
    // (packages/proxy/src/http.ts:174); hint is for API callers that read
    // HobbyError.toWire() (packages/core/src/errors.ts:59-66) rather than a
    // browser body. The command shape matches deployApp's identical usage
    // error (packages/app/src/app.ts:434-438) and deployWorker's
    // (packages/worker/src/worker.ts:545-549), so the proxy and the CLI
    // never disagree about how to fix this.
    if (resource.state === 'undeployed') {
      const command = `hobby deploy <path> --project ${project.name} --name ${resource.name}`
      throw new HobbyError(
        'conflict',
        `${hostname} has no code deployed yet, run \`${command}\` from the directory holding its code`,
        `run \`${command}\` from the directory holding its code`
      )
    }

    return {
      resourceId: resource.id,
      host: '127.0.0.1',
      port: resource.config.hostPort,
      state: resource.state,
    }
  }

  // Caddy's on-demand TLS gate. Deliberately the same lookup as resolve, so
  // there is exactly one definition of "a hostname this box serves", and
  // deliberately swallowing the released-project refusal: a released project
  // is a reason not to route a request, not a reason to refuse a
  // certificate for a name that genuinely belongs to this box.
  async function allowHostname(hostname: string): Promise<boolean> {
    try {
      return (await resolve(hostname)) !== null
    } catch {
      return true
    }
  }

  return {
    resolve,
    allowHostname,
    wake: getOrCreateWake(ctx),
    isWakeRefused: (resourceId: string) => isWakeRefused(ctx, resourceId),
    activity: ctx.activity,
  }
}
