// Caddy as the HTTP front door (ADR 0009): a container Hobbyist manages,
// configured entirely over its admin API, with no config files on disk. See
// the task report for the one real limitation this file works around: the
// ComputeRuntime/ContainerSpec contract (packages/core/src/runtime.ts) has
// no way to bind a published port to a specific host address, and no way to
// override a container's command. `network: 'host'` (below) is the answer
// to both: the container shares the host's network namespace outright, so
// Caddy's admin listener is on the same loopback interface the daemon
// itself runs on, and ports 80/443 that Caddy binds are reachable exactly
// the way a host-installed reverse proxy would be, with nothing published
// via `-p` at all.
//
// "No config files on disk" has one exception since issue #132: a one-line
// bootstrap Caddyfile holding only the admin address (`{ admin
// 127.0.0.1:<caddyAdminPort> }`), bind-mounted over the image's default so
// the admin API comes up on the configured port rather than Caddy's own
// default of 2019. It carries no routes. The very first POST to /load below
// still replaces the entire running config, in memory, with whatever this
// manager decides routes should be: there is never a moment after startup
// where Caddy is serving its own default page instead of ours, and there is
// never a file on disk holding our routes for an operator to find or
// hand-edit.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { HobbyError, type ComputeRuntime } from '@hobby.sh/core'
import { waitForHttpReachable } from './preflight.js'

const CADDY_CONTAINER_NAME = 'hobby-caddy'
// Where the image's own default Caddyfile lives, and therefore where the
// bootstrap file below is bind-mounted so `caddy run` reads ours instead.
const CADDY_CONFIG_PATH = '/etc/caddy/Caddyfile'
const CADDY_IMAGE = 'caddy:2-alpine'
const CADDY_SERVER_NAME = 'hobby'
const FALLBACK_ROUTE_ID = 'hobby-fallback'
const STOP_TIMEOUT_SEC = 10

// How long ensureRunning waits, after start() returns, for Caddy's admin API
// to answer before giving up. `docker start` resolving only means the
// container was asked to run, not that Caddy inside it has bound :2019 yet;
// without this wait, the very next call (setFallback) fires microseconds
// later, gets ECONNREFUSED, and the front door never opens. Measured boot
// time on this box (2026-08-14, OrbStack): about 160ms (see preflight.ts's
// HOST_NETWORKING_CONNECT_TIMEOUT_MS, which this mirrors); this leaves close
// to 10x margin for a loaded box or a cold layer cache.
const ADMIN_READY_TIMEOUT_MS = 1_500

export interface CaddyRoute {
  // A stable identifier for this route, used as Caddy's own `@id` so a
  // later addRoute or removeRoute call for the same id replaces or deletes
  // exactly this route rather than appending a duplicate.
  id: string
  // The Host header this route matches. Studio's own route matches the
  // hostname or IP the operator configured at `hobby init`; Phase 2 apps
  // would each get their own.
  host: string
  // Where matched requests are reverse-proxied to, e.g. "127.0.0.1:7432"
  // for the daemon's own loopback API port.
  upstream: string
}

// The catch-all. One route, appended after every host-matched route, with no
// matcher at all, pointing at the daemon's HTTP wake router.
//
// This is what keeps Caddy static as apps come and go. The alternative,
// pushing a Caddy route per deployed app, would mean an admin API call on
// every deploy and destroy, and a Caddy config that drifts from the store
// whenever one of those calls fails. Our router already has to resolve the
// Host header in order to know what to wake, so having Caddy resolve it too
// is duplicated state for no gain.
export interface CaddyFallback {
  // e.g. "127.0.0.1:7433"
  upstream: string
  // Where Caddy asks "is this hostname real?" before issuing a certificate
  // for a name nobody configured ahead of time. Absent means on-demand TLS
  // is off and only the operator's own configured hostname gets a
  // certificate.
  askUrl?: string
}

export interface CaddyManager {
  // Idempotent: safe to call on every daemon start. Creates the container
  // if absent (never recreates one that already exists, matching every
  // other ComputeRuntime caller's ensureCreated contract) and starts it.
  ensureRunning(): Promise<void>
  // Adds or replaces (by id) a route, then pushes the complete route table
  // to Caddy's admin API in one POST /load call. Prints the one-time
  // exposure warning (see warnOnFirstExposure below) before the first ever
  // route is pushed.
  addRoute(route: CaddyRoute): Promise<void>
  removeRoute(id: string): Promise<void>
  // Installs (or clears, with null) the catch-all route. Idempotent and
  // pushed immediately, like addRoute. Called once at daemon start; nothing
  // calls it again per deploy, which is the entire point.
  setFallback(fallback: CaddyFallback | null): Promise<void>
  stop(): Promise<void>
}

type FetchFn = typeof fetch

export interface CreateCaddyManagerOptions {
  adminPort: number
  // Overridable for tests only; production always talks to the loopback
  // interface Caddy's admin API is bound to, never a public one (ADR 0009:
  // "The admin API is a control surface on the box. It binds to loopback
  // and is reachable only by the daemon.").
  adminHost?: string
  fetchFn?: FetchFn
  // Where ensureRunning writes the one-line bootstrap Caddyfile that puts
  // Caddy's admin API on `adminPort` before the first POST /load (issue
  // #132): a file under HOBBY_HOME, bind-mounted over the image's default
  // Caddyfile. Without it the container starts with the image's default,
  // admin on 2019, and any other `caddyAdminPort` is polled forever and
  // never answers. Optional only so the unit tests, whose fake runtime
  // mounts nothing, can leave it out; startDaemon always passes it.
  caddyfilePath?: string
}

// Caddy reads its admin address from the config it is running, so the
// address has to appear in two places: the bootstrap Caddyfile the container
// starts from (renderBootstrapCaddyfile) and every config pushed over the
// admin API afterwards (buildConfig). A pushed config with no `admin` block
// would move the listener back to Caddy's default, 2019, and the next push
// would fail to reach it.
function adminListen(adminHost: string, adminPort: number): string {
  return `${adminHost}:${adminPort}`
}

export function renderBootstrapCaddyfile(adminHost: string, adminPort: number): string {
  return `{\n\tadmin ${adminListen(adminHost, adminPort)}\n}\n`
}

export function buildConfig(
  routes: Map<string, CaddyRoute>,
  fallback: CaddyFallback | null,
  admin: { host: string; port: number }
): unknown {
  const matched = [...routes.values()].map((route) => ({
    '@id': route.id,
    match: [{ host: [route.host] }],
    handle: [
      {
        handler: 'reverse_proxy',
        upstreams: [{ dial: route.upstream }],
      },
    ],
  }))

  // Order is the whole contract here. Caddy evaluates routes in order and a
  // route with no `match` matches everything, so the catch-all has to be
  // last or it would swallow Studio's own hostname.
  const all =
    fallback === null
      ? matched
      : [
          ...matched,
          {
            '@id': FALLBACK_ROUTE_ID,
            handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: fallback.upstream }] }],
          },
        ]

  const config: Record<string, unknown> = {
    admin: { listen: adminListen(admin.host, admin.port) },
    apps: {
      http: {
        servers: {
          [CADDY_SERVER_NAME]: {
            listen: [':80', ':443'],
            routes: all,
          },
        },
      },
    },
  }

  // On-demand TLS, and the ask endpoint that makes it safe. Without `ask`,
  // Caddy would attempt to issue a certificate for any hostname anyone
  // pointed at this box, which is both a way to get rate-limited by Let's
  // Encrypt and a way for a stranger to make our box do work on demand. The
  // ask endpoint answers only yes or no, and never enumerates.
  if (fallback?.askUrl !== undefined) {
    ;(config['apps'] as Record<string, unknown>)['tls'] = {
      automation: {
        policies: [{ on_demand: true }],
        // Inside `automation`, beside `policies`, not inside a policy and
        // not a sibling of `automation`: Caddy's JSON schema places the
        // global permission check at apps.tls.automation.on_demand, and the
        // earlier sibling placement made Caddy v2.11 reject the whole config
        // with `tls: json: unknown field "on_demand"`, so HTTPS never came
        // up at all (issue #131). Verified by posting both shapes to a real
        // Caddy admin API.
        on_demand: { permission: { module: 'http', endpoint: fallback.askUrl } },
      },
    }
  }

  return config
}

export function createCaddyManager(runtime: ComputeRuntime, opts: CreateCaddyManagerOptions): CaddyManager {
  const admin = { host: opts.adminHost ?? '127.0.0.1', port: opts.adminPort }
  const adminBase = `http://${admin.host}:${admin.port}`
  const fetchFn = opts.fetchFn ?? fetch
  const routes = new Map<string, CaddyRoute>()
  let fallback: CaddyFallback | null = null
  let warned = false

  // Decision 1 from the task brief: printed once, the first time a route
  // is actually published (not merely when the container starts, since an
  // unrouted Caddy serves nothing of ours). This is a plain, honest warning,
  // not a security control, and it belongs at the exact moment something
  // becomes reachable from the network.
  function warnOnFirstExposure(): void {
    if (warned) {
      return
    }
    warned = true
    console.error(
      'studio: publishing a Caddy route, which exposes the daemon to the network for the first time. ' +
        'The auth path behind it (packages/cli/src/daemon/studio: operator credential, sessions, rate ' +
        'limiting) was written in a single unattended session and has not been reviewed or exercised ' +
        'against a live host. Read it before pointing this at the internet.'
    )
  }

  async function push(): Promise<void> {
    let res: Response
    try {
      res = await fetchFn(`${adminBase}/load`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildConfig(routes, fallback, admin)),
      })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      throw new HobbyError('runtime_unavailable', 'could not reach the caddy admin API', detail)
    }
    if (!res.ok) {
      // Caddy says exactly which field it rejected, and that text is the
      // whole diagnosis. In the message, not only the hint: the daemon's
      // startup path prints errorMessage(err) and nothing else, so a detail
      // kept on the hint was never seen (issue #131).
      const detail = (await res.text().catch(() => '')).trim()
      throw new HobbyError(
        'runtime_unavailable',
        detail === '' ? 'caddy admin API rejected the config' : `caddy admin API rejected the config: ${detail}`
      )
    }
  }

  return {
    async ensureRunning(): Promise<void> {
      // Written on every start, not only on create: the container keeps the
      // bind to this path, and `docker start` makes Caddy re-read it, so a
      // changed caddyAdminPort takes effect on the next daemon start without
      // recreating anything. The exception is a hobby-caddy container made
      // before this file was mounted at all (no bind, image default admin
      // on 2019); that one has to be removed once, and the error below says
      // so (issue #132).
      const binds: Array<{ host: string; container: string }> = []
      if (opts.caddyfilePath !== undefined) {
        await mkdir(dirname(opts.caddyfilePath), { recursive: true })
        await writeFile(opts.caddyfilePath, renderBootstrapCaddyfile(admin.host, admin.port), 'utf8')
        binds.push({ host: opts.caddyfilePath, container: CADDY_CONFIG_PATH })
      }
      await runtime.ensureCreated({
        name: CADDY_CONTAINER_NAME,
        image: CADDY_IMAGE,
        env: {},
        ports: [],
        binds,
        network: 'host',
      })
      await runtime.start(CADDY_CONTAINER_NAME)
      // start() resolving is not Caddy answering, it is Docker saying the
      // container was asked to run (see ADMIN_READY_TIMEOUT_MS above), so
      // poll the same way preflight.ts's own throwaway-container probe does
      // (waitForHttpReachable, shared rather than duplicated) instead of
      // firing setFallback's POST /load the instant start() returns.
      const reachable = await waitForHttpReachable(`${adminBase}/config/`, ADMIN_READY_TIMEOUT_MS, fetchFn)
      if (!reachable) {
        throw new HobbyError(
          'runtime_unavailable',
          `the caddy admin API never became reachable at ${adminBase} within ${ADMIN_READY_TIMEOUT_MS}ms of starting the container`,
          `caddyAdminPort is ${admin.port}. If the ${CADDY_CONTAINER_NAME} container was created by an older daemon it still ` +
            `uses the image's default admin address (localhost:2019): remove it (docker rm -f ${CADDY_CONTAINER_NAME}) and ` +
            'start the daemon again so it is recreated with the configured address.'
        )
      }
    },

    async addRoute(route: CaddyRoute): Promise<void> {
      warnOnFirstExposure()
      routes.set(route.id, route)
      await push()
    },

    async removeRoute(id: string): Promise<void> {
      routes.delete(id)
      await push()
    },

    // No exposure warning here: the catch-all routes to the HTTP router,
    // which serves apps and the tls-ask endpoint, not the daemon's auth
    // path. Warning from here printed the studio warning on every start of
    // a daemon that had no studio route at all (issue #131); addRoute,
    // which is what publishes the studio hostname, keeps it.
    async setFallback(next: CaddyFallback | null): Promise<void> {
      fallback = next
      await push()
    },

    async stop(): Promise<void> {
      await runtime.stop(CADDY_CONTAINER_NAME, { timeoutSec: STOP_TIMEOUT_SEC })
    },
  }
}
