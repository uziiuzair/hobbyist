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
import { formatRetryDelay } from '../daemon/wake-backoff.js'
import type { WireResource, WireSnapshotManifest } from '../daemon/wire.js'
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
//
// A resource whose automatic wakes the daemon is currently turning away
// (issue #10's refusal, now a backoff: buildWake in
// packages/cli/src/daemon/context.ts) gets a second trailer saying so, when
// it is retried, and a short form of why. This line is the one place a
// person routinely looks, and before it said this the refusal was visible
// only as error text in whichever application happened to connect. `now` is
// a parameter so the countdown is testable; it is a relative time rather
// than a date, which is what this file's header asks of human output.
export function renderResourceLine(resource: WireResource, now: number = Date.now()): string {
  return `${renderResourceColumns(resource)}${wakeRefusalTrailer(resource, now)}`
}

function renderResourceColumns(resource: WireResource): string {
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

// Long enough to recognise the failure ("exec format error", "did not become
// ready within 30000ms"), short enough to keep a listing a listing. The full
// message is in `hobby ls --json`, and the full story in `hobby logs`.
const REFUSAL_ERROR_PREVIEW = 60

function wakeRefusalTrailer(resource: WireResource, now: number): string {
  const refusal = resource.wakeRefusal
  if (refusal === undefined || refusal === null) {
    return ''
  }
  const error =
    refusal.lastError.length > REFUSAL_ERROR_PREVIEW
      ? `${refusal.lastError.slice(0, REFUSAL_ERROR_PREVIEW - 3)}...`
      : refusal.lastError
  const remaining = Date.parse(refusal.retryAt) - now
  // Past its retry time the entry is still there until the next automatic
  // wake tries (see getWakeRefusal's comment): nothing is refused any more,
  // and saying "retry in 0s" forever would read as a stuck countdown.
  if (!(remaining > 0)) {
    const times = refusal.failures === 1 ? '' : ` ${refusal.failures} times`
    return `  (last wake failed${times}, retried on the next connection: ${error})`
  }
  return `  (wake refused, retry in ${formatRetryDelay(remaining)}: ${error})`
}

// One row of `hobby snapshot ls`. No date column, per this file's header:
// the id already is the timestamp (snapshotId, packages/cli/src/daemon/snapshots.ts,
// sortable and in UTC), so nothing is lost. The verification column prints
// the tri-state as it is, `unverified` included, because a check that never
// ran must never read as one that passed (the spec's "Verification").
//
// `online` is appended when any resource was captured running with
// pg_basebackup, because that is the snapshot whose restore runs recovery
// on first start, and a reader choosing which one to restore should see it.
export function renderSnapshotLine(manifest: WireSnapshotManifest): string {
  const count = manifest.resources.length
  const online = manifest.resources.some((resource) => resource.method === 'basebackup') ? '  online' : ''
  return `${manifest.snapshotId}  ${count} resource${count === 1 ? '' : 's'}  ${manifest.clone}  ${manifest.verification.status}${online}`
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
// ADR 0017 changed the default from every interface to loopback, so the first
// thing a user does after installing, connect something, now behaves
// differently depending on a setting they have never seen. This states what
// was bound and how to change it, rather than leaving them to discover it from
// a refused connection.
export function proxyBindNote(proxyHost: string): string {
  const setting = proxyHost.trim()

  if (setting === 'all') {
    return (
      'warning: the proxy is bound to every interface, and it speaks no TLS. On a machine with a ' +
      'public address that puts postgres on the internet in cleartext. Firewall the port, or set ' +
      'proxyHost to "tailnet" or an address. https://hobbyist.sh/docs/reference/configuration/'
    )
  }

  if (setting === 'tailnet') {
    return 'proxy: bound to loopback and this machine\'s tailnet address.'
  }

  if (setting === '127.0.0.1' || setting === 'localhost' || setting === '::1') {
    return (
      'proxy: bound to loopback only, so nothing off this box can reach a database yet. ' +
      'To change that, set proxyHost to "tailnet" (recommended), to an address, or to "all". ' +
      'https://hobbyist.sh/docs/reference/configuration/'
    )
  }

  return `proxy: bound to ${setting}.`
}

// The half of the ext4 explanation both notes below share, so the reason and
// the remedy are worded once: `hobby init` says it ahead of time and
// `hobby branch` says it at the moment it applies, and two copies of the
// advice would drift.
const REFLINK_REMEDY =
  'this is expected on ext4, the default on many cheap VPS images. ' +
  'if you want cheap copies, put $HOBBY_HOME on XFS, ZFS or APFS. ' +
  'https://hobbyist.sh/docs/reference/filesystems/'

export function reflinkWarning(report: PreflightReport): string | null {
  if (report.filesystem.reflinkSupported) {
    return null
  }
  // Deliberately "note" and not "warning". Branching and snapshots both
  // work on this filesystem; each is just a real copy instead of an instant
  // one, which is what ADR 0016 means by ext4 users paying linearly. That is
  // a cost to know about rather than a fault, and alarming language in the
  // first message most cheap-VPS users ever see spends credibility on
  // something that is not broken.
  //
  // The link is a URL rather than a repo path, because someone who ran the
  // one-liner has no checkout in front of them to open.
  return (
    'note: this filesystem has no reflink support, so copying a project will be a full copy ' +
    'rather than an instant one. today that means `hobby branch` and `hobby snapshot`, which both ' +
    'still work, each at the cost of the full size of the data and the time to copy it. ' +
    REFLINK_REMEDY
  )
}

// Printed by `hobby branch` when cloneTree (packages/core/src/copy.ts) had
// to fall back to a byte copy. Said after the fact rather than refused up
// front: the branch is correct either way, and the only difference is what
// it cost, which the user should hear about the first time they pay it.
export function branchCopyNote(): string {
  return (
    'note: this filesystem has no reflink support, so this branch is a full copy rather than an ' +
    'instant one, and takes the full size of the data on disk. ' +
    REFLINK_REMEDY
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
