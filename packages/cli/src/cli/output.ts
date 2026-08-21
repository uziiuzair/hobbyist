// Human rendering. Every function here takes exactly the object the API
// call already produced and renders it; none of them fetch anything or
// decide anything the caller hasn't already decided. That is what keeps
// --json and human output from ever being two code paths that can drift:
// --json prints JSON.stringify of that same object, human output is
// print(renderX(thatObject)) in commands.ts, always the same data in both
// branches.
//
// Nothing here prints dates. Project/Resource's createdAt/lastActiveAt are
// typed as Date in @hobby.sh/core but arrive over the wire, through
// JSON.parse, as plain ISO strings (see the file comment in client.ts).
// Rather than call a Date method on a value that is not actually a Date at
// runtime, human output simply never shows timestamps in this task; nothing
// in the brief required it, and inventing a `new Date(x)` coercion here
// would be more type-widening than the requirement is worth.

import type { PreflightReport } from '../daemon/preflight.js'
import type { WireResource } from '../daemon/wire.js'
import type { QueueListEntry, QueueMessage } from './client.js'

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

// Postgres is reached on its own port through the proxy, so its line shows
// that. An app or worker is reached by hostname instead (its port is an
// implementation detail nobody types), and an `undeployed` one (Task 4:
// created with no source and nothing built yet) gets an explicit trailer,
// because "no code yet" is the one piece of information this line exists to
// surface for that state; the daemon's own wording for the same fact lives
// in packages/app/src/app.ts:434-438 and packages/worker/src/worker.ts's
// matching throw, and this is deliberately shorter, since a listing is read
// many times and a usage command is not needed until the user acts on it.
export function renderResourceLine(resource: WireResource): string {
  if (resource.kind === 'postgres') {
    return `${resource.name}  ${resource.kind}  ${resource.state}  port ${resource.config.hostPort}`
  }
  // A queue is reached by neither: no port anybody dials, no hostname
  // anybody types, so the line simply ends. Its own branch rather than a
  // fallthrough, for the same reason redactConfig
  // (packages/cli/src/daemon/wire.ts) grew one: `queue` landed in the
  // app-and-worker case below and read a `hostname` a QueueConfig does not
  // have. Depth would be the useful column here and is deliberately not it:
  // it is a per-queue sqlite read, and `hobby ls` must stay one cheap call.
  if (resource.kind === 'queue') {
    return `${resource.name}  ${resource.kind}  ${resource.state}`
  }
  const trailer = resource.state === 'undeployed' ? '  (no code yet)' : ''
  return `${resource.name}  ${resource.kind}  ${resource.state}  ${resource.config.hostname}${trailer}`
}

// The consumer column of `hobby queue ls`. Deliberately the same wording
// `hobby ls` already uses for an undeployed worker (renderResourceLine's own
// trailer above), because the underlying fact is identical: no code has ever
// been deployed to it. A queue with no consumer bound at all is `(none)`, a
// different phrase for a different fact: nothing is wrong, nobody has bound
// a consumer yet, and messages simply accumulate until retention expires.
export function renderQueueConsumer(consumer: WireResource | null): string {
  if (consumer === null) {
    return '(none)'
  }
  if (consumer.kind === 'worker' && consumer.config.manifest === null) {
    return `${consumer.name} (no code yet)`
  }
  return consumer.name
}

// One line per queue for `hobby queue ls`: depth and oldest-message age come
// straight from the route's own sqlite read (routes.ts's readQueueStats), so
// this function only formats, never decides. `resource.config` is read only
// after narrowing to `kind === 'queue'`, the same discipline every other
// branch in this file already applies to a WireResource union.
export function renderQueueLine(entry: QueueListEntry): string {
  if (entry.resource.kind !== 'queue') {
    return entry.resource.name
  }
  const oldest = entry.oldestMessageAgeSeconds === null ? 'empty' : `oldest ${entry.oldestMessageAgeSeconds}s ago`
  const dlq = entry.resource.config.deadLetterQueue === null ? 'no dlq' : `dlq ${entry.resource.config.deadLetterQueue}`
  return `${entry.resource.name}  depth ${entry.depth}  ${oldest}  consumer ${renderQueueConsumer(entry.consumer)}  ${dlq}`
}

// One line per message for `hobby queue peek`. The body is already decoded
// JSON (routes.ts's peek route runs decodeBody before this ever sees it), so
// this is a plain JSON.stringify, the same rendering --json would show for
// the same field.
export function renderQueueMessageLine(message: QueueMessage): string {
  return `${message.id}  attempts ${message.attempts}  ${JSON.stringify(message.body)}`
}

// The reflink warning is deliberately not part of this function's output.
// renderPreflight's lines are all meant for stdout (io.out); a warning
// belongs on stderr (io.err) instead, so it never corrupts the output of
// anyone piping or parsing `hobby init`'s stdout. See reflinkWarning below
// and its caller in commands.ts's cmdInit.
export function renderPreflight(report: PreflightReport): string[] {
  const lines: string[] = []
  lines.push(`container runtime: ${report.runtimeAvailable ? 'available' : 'NOT AVAILABLE'}`)
  lines.push(
    `filesystem (${report.filesystem.path}): reflink clone ${
      report.filesystem.reflinkSupported ? 'supported' : 'NOT supported'
    }, ${formatBytes(report.filesystem.freeBytes)} free`
  )
  lines.push(`proxy port ${report.ports.proxy.port}: ${report.ports.proxy.bound ? 'already in use' : 'free'}`)
  lines.push(`studio port ${report.ports.studio.port}: ${report.ports.studio.bound ? 'already in use' : 'free'}`)
  return lines
}

// null when there is nothing to warn about. Always routed to io.err by the
// caller, in both --json and human mode, since it is advisory information
// that must never land on the same stream as the JSON body or the plain
// report lines above.
export function reflinkWarning(report: PreflightReport): string | null {
  if (report.filesystem.reflinkSupported) {
    return null
  }
  // Deliberately "note" and not "warning", and deliberately not phrased as
  // branching being degraded. Branching is not built and snapshots are not
  // reachable from any command, so nothing a reader can run today is slower
  // because of this. Warning about a feature that does not exist, in the first
  // message most cheap-VPS users ever see, spends credibility for nothing.
  //
  // The link is a URL rather than a repo path, because someone who ran the
  // one-liner has no checkout in front of them to open.
  return (
    'note: this filesystem has no reflink support, so copying a project will be a full copy ' +
    'rather than an instant one. nothing available today depends on it: snapshots and branching ' +
    'are both still to come. this is expected on ext4, the default on many cheap VPS images. ' +
    'if you want cheap copies later, put $HOBBY_HOME on XFS, ZFS or APFS. ' +
    'https://hobbyist.sh/docs/reference/filesystems/'
  )
}

// Same shape and reasoning as reflinkWarning above, and routed to io.err by
// cmdInit the same way: null when there is nothing to warn about. That
// includes report.hostNetworking === null (caddy disabled, so the check
// never ran and there is nothing to say about it), not just the supported
// case, so this only ever fires when caddy is enabled and the probe found a
// real problem.
export function hostNetworkingWarning(report: PreflightReport): string | null {
  if (report.hostNetworking === null || report.hostNetworking.supported) {
    return null
  }
  return (
    'caddy: this container runtime does not appear to support host networking, which Caddy needs ' +
    'in order to bind :80 and :443 and to reach the daemon. Docker Desktop for macOS is the known ' +
    'case. Linux and OrbStack both work. Hobbyist will start without a front door: apps are ' +
    'reachable on their loopback ports and `hobby studio` still works.'
  )
}
