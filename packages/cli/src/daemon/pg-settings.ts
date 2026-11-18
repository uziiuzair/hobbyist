// Applying a postgres resource's server settings (packages/pg/src/
// settings.ts). The settings are server arguments on the container's
// command, so every change means a new container on the same data
// directory: docker cannot change a container's command in place, and
// Postgres does not re-read command-line settings on pg_reload_conf, which
// only re-reads the config files hobby never writes (ADR 0003). That holds
// for settings Postgres calls reloadable too, and the response says so.
//
// How a change lands depends on whether the database is awake:
//
//   asleep (or failed)  The stopped container is replaced at once and
//                       nothing is started. The new settings take effect on
//                       the next wake, whoever causes it. Applying settings
//                       never wakes a sleeping database (ADR 0007).
//   awake               A pause, with the conventions `hobby branch` and
//                       snapshots use: a pinned project needs allowPause;
//                       the activity guard must say idle (waitForIdle, the
//                       snapshot's fail-loudly rule) before anything stops;
//                       wakes are held off (holdProjectAsleep) so a pool
//                       reconnecting mid-swap waits instead of starting the
//                       old container, and a new connection waits for the
//                       restarted one instead of being refused. Then stop,
//                       recreate, start, release.
//
// A start that fails with the new settings (a shared_buffers the box
// cannot allocate, say) is rolled back: the previous settings are stored,
// the container is recreated from them and started again, and the error
// carries the failed start's log lines. A database is never left down
// because of a settings change made while it was serving.

import {
  HobbyError,
  guardFor,
  type PostgresConfig,
  type PostgresResource,
  type Project,
  type Resource,
} from '@hobby.sh/core'
import {
  missingPreloads,
  nextSettings,
  recreatePostgresContainer,
  type MissingPreload,
  type PostgresSettings,
} from '@hobby.sh/pg'
import { assertPauseAllowed } from './branch.js'
import { clearWakeRefusal, holdProjectAsleep, type DaemonContext } from './context.js'
import { DEFAULT_QUIESCE_ATTEMPTS, DEFAULT_QUIESCE_WAIT_MS, waitForIdle, type QuiesceOptions } from './snapshots.js'

export interface SettingsChange {
  set?: Record<string, unknown>
  unset?: string[]
  allowPause?: boolean
  // Test seam, the same one snapshots and branch take.
  quiesce?: QuiesceOptions
  now?: () => number
}

export type SettingsApplied =
  // Nothing differed from what is stored; no container was touched.
  | 'unchanged'
  // The database was asleep: its container was replaced, and the settings
  // take effect when it next wakes.
  | 'next-start'
  // The database was awake and was restarted with the new settings.
  | 'restarted'

export interface SettingsResult {
  resource: PostgresResource
  settings: PostgresSettings
  applied: SettingsApplied
  // Stop to ready, for a restart; null otherwise.
  pausedMs: number | null
  // Declared or installed extensions whose library the new settings no
  // longer preload. Allowed (unsetting a preload is a legitimate thing to
  // want), but said out loud.
  needsPreload: MissingPreload[]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sameSettings(a: PostgresSettings | undefined, b: PostgresSettings): boolean {
  const left = Object.entries(a ?? {})
  return left.length === Object.keys(b).length && left.every(([key, value]) => b[key] === value)
}

function withSettings(config: PostgresConfig, settings: PostgresSettings): PostgresConfig {
  const next: PostgresConfig = { ...config }
  if (Object.keys(settings).length > 0) {
    next.settings = settings
  } else {
    delete next.settings
  }
  return next
}

export async function applyPostgresSettings(
  ctx: DaemonContext,
  project: Project,
  resource: PostgresResource,
  change: SettingsChange
): Promise<SettingsResult> {
  const now = change.now ?? Date.now
  if (project.releasedAt != null) {
    throw new HobbyError(
      'conflict',
      `project ${project.name} was released and is no longer managed by hobby`,
      `its compose file's command: is where its settings live now; run \`hobby adopt ${project.name}\` to manage it again`
    )
  }

  const settings = nextSettings(resource.config.settings, change)
  const needsPreload = missingPreloads(resource.config.extensions ?? [], settings)
  if (sameSettings(resource.config.settings, settings)) {
    return { resource, settings, applied: 'unchanged', pausedMs: null, needsPreload }
  }

  if (resource.state === 'starting' || resource.state === 'stopping' || resource.state === 'creating') {
    throw new HobbyError(
      'conflict',
      `${project.name}/${resource.name} is ${resource.state}`,
      'try again once it is running or asleep'
    )
  }

  const awake = resource.state === 'running'
  if (awake) {
    assertPauseAllowed(project, [resource], change.allowPause === true, 'applying these settings', 'while Postgres restarts')
  }

  // The hold is what keeps a restart from refusing new connections (Phase
  // A3, 2026-11-18): every wake path (the Postgres proxy over plain TCP,
  // TLS and the serverless driver's /sql and WebSocket, the HTTP router,
  // the query route, `hobby wake`) waits on its fence, so a connection that
  // arrives while the container is down is held until the restart is done
  // and then served by the new container. If the database does not come
  // back, the release names it, and those waiters get this operation's
  // error instead of each starting the container again (buildWake,
  // context.ts). Waiting is bounded by the proxy's wakeTimeoutMs, the same
  // budget a cold wake gets. Sessions that were open when it stopped still
  // end: Postgres is restarted, and nothing carries a session across that.
  const release = holdProjectAsleep(ctx, project.id, project.name, 'a settings change')
  // Set once this function has stopped the database, and the message of
  // whatever went wrong after that. Read in finally: a database this call
  // stopped and that is not running at the end is reported to the waiters.
  let stoppedHere = false
  let failure: string | null = null
  try {
    // Re-read under the hold: a wake that finished just before it was
    // taken changed the state this decision rests on.
    const held = ctx.store.getResource(resource.id)
    if (held === null || held.kind !== 'postgres') {
      throw new HobbyError('resource_not_found', `${project.name}/${resource.name} no longer exists`)
    }
    const current = held as PostgresResource
    const previous = current.config

    // Asleep, or went to sleep between the first read and the hold, which
    // leaves nothing to pause.
    if (current.state !== 'running') {
      const updated = await recreatePostgresContainer(ctx, {
        project,
        resource: current,
        config: withSettings(previous, settings),
      })
      return { resource: updated, settings, applied: 'next-start', pausedMs: null, needsPreload }
    }

    // Awake. The pinned guard again, for a resource that woke between the
    // first read and the hold.
    assertPauseAllowed(project, [current], change.allowPause === true, 'applying these settings', 'while Postgres restarts')
    const guard = change.quiesce?.guard ?? ((r: Resource) => guardFor(ctx.kinds, ctx, r))
    await waitForIdle(
      current,
      guard,
      change.quiesce?.attempts ?? DEFAULT_QUIESCE_ATTEMPTS,
      change.quiesce?.waitMs ?? DEFAULT_QUIESCE_WAIT_MS,
      change.quiesce?.sleepFor ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )

    const started = now()
    const handler = ctx.kinds.get('postgres')
    stoppedHere = true
    await handler.stop(ctx, current)
    const updated = await recreatePostgresContainer(ctx, {
      project,
      resource: current,
      config: withSettings(previous, settings),
    })
    try {
      await handler.start(ctx, updated)
    } catch (startErr) {
      const why = startErr instanceof HobbyError && startErr.hint !== undefined ? `${errorMessage(startErr)}\n${startErr.hint}` : errorMessage(startErr)
      try {
        const restored = await recreatePostgresContainer(ctx, { project, resource: updated, config: previous })
        await handler.start(ctx, restored)
      } catch (rollbackErr) {
        throw new HobbyError(
          'wake_failed',
          `${project.name}/${resource.name} did not start with the new settings, and restoring the previous ones failed too: ${errorMessage(rollbackErr)}`,
          `the previous settings are stored again; \`hobby wake ${project.name}\` retries with them. the start with the new settings failed with: ${why}`
        )
      }
      clearWakeRefusal(ctx, resource.id)
      throw new HobbyError(
        'usage',
        `${project.name}/${resource.name} did not start with the new settings, so the previous ones were restored and it is running again`,
        why
      )
    }
    const final = ctx.store.getResource(resource.id) as PostgresResource
    return { resource: final, settings, applied: 'restarted', pausedMs: now() - started, needsPreload }
  } catch (err) {
    failure = errorMessage(err)
    throw err
  } finally {
    const after = stoppedHere ? ctx.store.getResource(resource.id) : null
    if (stoppedHere && after?.state !== 'running') {
      release(new Map([[resource.id, failure ?? 'it was not running when the settings change finished']]))
    } else {
      release()
    }
  }
}
