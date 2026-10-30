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

import type { Project } from '@hobby.sh/core'
import { DEFAULT_CONSUMER_OPTIONS } from '@hobby.sh/queue'
import type { PortCheck, PreflightReport } from '../daemon/preflight.js'
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

// Postgres is reached through the proxy, and its line says how: `hobby
// connect <project>/<name>` (issue #103). It used to show the container's
// own host port, which bypasses the wake router: a connection there fails
// while the database sleeps, and an idle one is terminated by hibernation
// (packages/pg/src/activity-guard.ts). The port is still in `--json` as
// `config.hostPort`, for whoever knows what they are doing with it. An app
// or worker is reached by hostname instead (its port is an
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
export function renderResourceLine(resource: WireResource, now: number = Date.now(), projectName?: string): string {
  return `${renderResourceColumns(resource, projectName)}${wakeRefusalTrailer(resource, now)}`
}

function renderResourceColumns(resource: WireResource, projectName: string | undefined): string {
  if (resource.kind === 'postgres') {
    const target = projectName === undefined ? resource.name : `${projectName}/${resource.name}`
    return `${resource.name}  ${resource.kind}  ${resource.state}  connect: hobby connect ${target}`
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

// The project line's sleep policy, when it is worth a word (issue #111):
// `(pinned)` for a null threshold, which `hobby ls` never showed, and the
// threshold itself when it differs from the daemon's default. A project on
// the box-wide default says nothing, so the common case stays one word.
// `boxDefault` undefined means the daemon predates reporting it, and then
// only the pin is shown: nothing here guesses what the default is.
export function sleepPolicyTrailer(
  project: Pick<Project, 'sleepAfterSeconds'>,
  boxDefault: number | null | undefined
): string {
  if (project.sleepAfterSeconds === null) {
    return '  (pinned)'
  }
  if (boxDefault !== undefined && project.sleepAfterSeconds !== boxDefault) {
    return `  (sleeps after ${project.sleepAfterSeconds}s)`
  }
  return ''
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
  const retention = `retention ${renderDuration(entry.resource.config.retentionSeconds)}`
  return `${entry.resource.name}  depth ${entry.depth}  ${oldest}  consumer ${renderQueueConsumer(entry.consumer)}  ${dlq}  ${retention}`
}

// The consumer tuning in force for a queue, or null when nothing consumes
// it (issue #170). Null keys on the row mean "the broker's default", resolved
// here exactly as packages/cli/src/daemon/queues.ts's drainableQueues
// resolves them for delivery, so what this prints is what the tick uses.
// Rendered on its own indented line under renderQueueLine, so `hobby queue
// ls` stays readable for a queue that has no consumer at all.
export function renderQueueTuningLine(entry: QueueListEntry): string | null {
  if (entry.resource.kind !== 'queue' || entry.consumer === null) {
    return null
  }
  const cfg = entry.resource.config
  const batchSize = cfg.maxBatchSize ?? DEFAULT_CONSUMER_OPTIONS.maxBatchSize
  const batchTimeout = cfg.maxBatchTimeoutSeconds ?? DEFAULT_CONSUMER_OPTIONS.maxBatchTimeoutSeconds
  const retries = cfg.maxRetries ?? DEFAULT_CONSUMER_OPTIONS.maxRetries
  const retryDelay = cfg.retryDelaySeconds ?? DEFAULT_CONSUMER_OPTIONS.retryDelaySeconds
  return `batch ${batchSize} msgs or ${renderDuration(batchTimeout)}  retries ${retries}  retry delay ${renderDuration(retryDelay)}`
}

// Whole seconds as the largest unit that divides them: 60 -> 1m, 3600 -> 1h,
// 345600 -> 4d, 90 -> 90s. Exact, never rounded, so a value the user set is
// echoed back as something that re-parses to the same number of seconds.
export function renderDuration(seconds: number): string {
  if (seconds % 86400 === 0 && seconds !== 0) return `${seconds / 86400}d`
  if (seconds % 3600 === 0 && seconds !== 0) return `${seconds / 3600}h`
  if (seconds % 60 === 0 && seconds !== 0) return `${seconds / 60}m`
  return `${seconds}s`
}

// One line per message for `hobby queue peek`. The body is already decoded
// JSON (routes.ts's peek route runs decodeBody before this ever sees it), so
// this is a plain JSON.stringify, the same rendering --json would show for
// the same field. A message that is not simply waiting says so (issue #170):
// `leased` is out with the consumer right now, `delayed` says when it becomes
// visible, and a dead letter says how many deliveries failed before it landed
// here (issue #168).
export function renderQueueMessageLine(message: QueueMessage, now: number = Date.now()): string {
  const notes: string[] = []
  if (message.state === 'leased') {
    notes.push('leased')
  } else if (message.state === 'delayed') {
    notes.push(`delayed, visible in ${renderDuration(Math.max(0, Math.ceil((message.visibleAtMs - now) / 1000)))}`)
  }
  if (message.failedAttempts !== null && message.failedAttempts !== undefined) {
    notes.push(`dead letter after ${message.failedAttempts} failed ${message.failedAttempts === 1 ? 'attempt' : 'attempts'}`)
  }
  const trailer = notes.length === 0 ? '' : `  ${notes.join(', ')}`
  return `${message.id}  attempts ${message.attempts}${trailer}  ${JSON.stringify(message.body)}`
}

// The reflink warning is deliberately not part of this function's output.
// renderPreflight's lines are all meant for stdout (io.out); a warning
// belongs on stderr (io.err) instead, so it never corrupts the output of
// anyone piping or parsing `hobby init`'s stdout. See reflinkWarning below
// and its caller in commands.ts's cmdInit.
// One line per port the daemon will bind, in the order the daemon binds
// them, each naming the host it is probed on (issue #108). "already in use"
// and "cannot bind" are the two outcomes that stop `hobby daemon`, and
// preflightBlockers below turns each into a reason the host is not ready.
function portLine(label: string, check: PortCheck): string {
  const state = check.error !== null ? `cannot bind (${check.error})` : check.bound ? 'already in use' : 'free'
  return `${label} port ${check.port} on ${check.host}: ${state}`
}

export function renderPreflight(report: PreflightReport): string[] {
  const lines: string[] = []
  lines.push(`container runtime: ${report.runtimeAvailable ? 'available' : 'NOT AVAILABLE'}`)
  lines.push(
    `filesystem (${report.filesystem.path}): reflink clone ${
      report.filesystem.reflinkSupported ? 'supported' : 'NOT supported'
    }, ${formatBytes(report.filesystem.freeBytes)} free`
  )
  if (report.proxyHost.error !== null) {
    lines.push(`proxy host "${report.proxyHost.setting}": ${report.proxyHost.error}`)
  }
  lines.push(portLine('proxy', report.ports.proxy))
  lines.push(portLine('api (daemon API and studio)', report.ports.api))
  lines.push(portLine('http', report.ports.http))
  lines.push(portLine('queue', report.ports.queue))
  for (const check of report.ports.caddy ?? []) {
    lines.push(portLine('caddy', check))
  }
  if (report.daemon !== null && report.daemon.running && !report.daemon.self) {
    lines.push(
      `daemon: already running (pid ${report.daemon.pid}), serving ${report.daemon.home} since ${report.daemon.startedAt}; ` +
        'the ports above are its'
    )
  }
  lines.push(studioExposureNote(report))
  return lines
}

// ADR 0008: "`hobby init` states plainly what is about to be reachable from
// the internet." Studio is served on the daemon's loopback API port and
// reaches the network only through Caddy, so there are exactly three
// honest sentences, one per configuration (issue #108).
export function studioExposureNote(report: PreflightReport): string {
  const served = `studio: served on ${report.studio.listen}`
  if (report.studio.publicHost !== null) {
    return (
      `${served}, published by caddy at https://${report.studio.publicHost}. ` +
      'That is reachable from the internet, behind the operator password (hobby studio passwd).'
    )
  }
  if (report.ports.caddy !== null) {
    return (
      `${served}, loopback only. caddy is on but no HOBBY_CADDY_STUDIO_HOST is set, so nothing off this box ` +
      'reaches studio; set one to publish it. https://hobbyist.sh/docs/reference/configuration/'
    )
  }
  return (
    `${served}, loopback only. nothing off this box reaches studio; use an ssh tunnel or tailscale serve, or ` +
    'enable caddy with a hostname. https://hobbyist.sh/docs/guides/tailscale-and-tunnels/'
  )
}

// The reasons `hobby daemon` would refuse to start on this host, one per
// line, or an empty list when it would not (issue #108). cmdInit prints
// these to stderr and withholds "host is ready". A port the daemon itself
// already holds (report.daemon.self, Studio asking a running daemon) is not
// a conflict and is not listed. A running daemon that is not this process
// is reported by cmdInit on its own, not here: it is a reason nothing needs
// starting, not a reason the host is broken.
export function preflightBlockers(report: PreflightReport): string[] {
  const reasons: string[] = []
  if (report.daemon?.self === true) {
    return reasons
  }
  if (report.proxyHost.error !== null) {
    reasons.push(
      `proxyHost "${report.proxyHost.setting}" cannot be used: ${report.proxyHost.error}. ` +
        'hobby daemon will refuse to start until it is changed.'
    )
  }
  const checks: Array<[string, PortCheck]> = [
    ['proxy', report.ports.proxy],
    ['api', report.ports.api],
    ['http', report.ports.http],
    ['queue', report.ports.queue],
    ...(report.ports.caddy ?? []).map((check): [string, PortCheck] => ['caddy', check]),
  ]
  for (const [label, check] of checks) {
    if (check.error !== null) {
      reasons.push(
        `${label} port ${check.port} cannot be bound on ${check.host} (${check.error}); hobby daemon would fail the same way`
      )
    } else if (check.bound) {
      reasons.push(`${label} port ${check.port} on ${check.host} is already in use by something else`)
    }
  }
  return reasons
}

// Below this, a snapshot or an image build is likely to end in ENOSPC
// (issue #139 saw it at 330 MB). A note, not a blocker: the host works,
// and the figure is about what the next write will find.
const LOW_DISK_BYTES = 1024 * 1024 * 1024

export function diskWarning(report: PreflightReport): string | null {
  if (report.filesystem.freeBytes >= LOW_DISK_BYTES) {
    return null
  }
  return (
    `note: only ${formatBytes(report.filesystem.freeBytes)} free under ${report.filesystem.path}. ` +
    'a snapshot, a branch or an image build is likely to fail with "no space left on device" before long.'
  )
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
//
// `tlsHostname` is proxyTls's hostname when TLS is configured (ADR 0019).
// With it, a wide bind is the intended setup rather than an accident, since
// plaintext from other machines is refused, so the cleartext warning would
// be false.
export function proxyBindNote(proxyHost: string, tlsHostname: string | null = null): string {
  const setting = proxyHost.trim()

  if (tlsHostname !== null) {
    const where = setting === 'all' ? 'every interface' : setting === 'tailnet' ? "loopback and this machine's tailnet address" : setting
    return (
      `proxy: bound to ${where}, with TLS for ${tlsHostname}. ` +
      'Connections from other machines must use sslmode=require; plaintext is refused.'
    )
  }

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
  'this is expected on ext4, the default on many cheap VPS images, and on XFS formatted with reflink=0. ' +
  'if you want cheap copies, put $HOBBY_HOME on XFS with reflink=1 (the mkfs.xfs default since 2019), ZFS or APFS. ' +
  'https://hobbyist.sh/docs/reference/filesystems/'

// tmpfs is RAM: a HOBBY_HOME there loses every data directory at reboot.
// Said at `hobby init`, the one moment the user is choosing the path.
export function tmpfsWarning(report: PreflightReport): string | null {
  if (!report.filesystem.tmpfs) {
    return null
  }
  return (
    `warning: ${report.filesystem.path} is on tmpfs, which lives in memory. ` +
    'every database here is lost at the next reboot. set HOBBY_HOME to a path on a real disk before creating anything.'
  )
}

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
