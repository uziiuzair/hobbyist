// Describing a Durable Object namespace without running it.
//
// Everything here is filesystem plus the alarm table. Nothing calls workerd,
// because the whole point is that this works while the runtime is stopped,
// which is the state a namespace spends most of its life in.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { HobbyError } from '@hobby.sh/core'
import { ALARM_DB_FILENAME, readPendingAlarms } from './alarms.js'

const OBJECT_SUFFIX = '.sqlite'

// workerd names each object's file after its actor id, which is a SHA-256
// sized value rendered as hex (actor-id-impl.h: SHA256_DIGEST_LENGTH). Used
// both to recognise object files and, in storage.ts, to refuse anything that
// could escape the namespace directory.
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/

export interface ObjectSummary {
  id: string
  // Populated only when the object has a pending alarm, because
  // _cf_ALARM.actor_name is the only place a name is written down. See
  // PendingAlarm.actorName. This is null far more often than not, and the
  // surfaces that render it say "unnamed" rather than inventing one.
  name: string | null
  // The .sqlite file only. A -wal that is about to be checkpointed is not
  // storage the user meaningfully owns, and counting it would make a
  // namespace's reported size jump around with no change in content.
  sizeBytes: number
  modifiedAtMs: number
  alarmAtMs: number | null
}

export interface NamespaceSummary {
  // The directory name, <durableObjectUniqueKeyModifier>-<ClassName>.
  uniqueKey: string
  className: string
  resourceId: string
  objectCount: number
  totalSizeBytes: number
  nextAlarmAtMs: number | null
  objects: ObjectSummary[]
}

// The modifier is the owning resource's UUID and a UUID contains hyphens,
// while a JavaScript class name cannot, so the split is at the LAST hyphen.
// Verified against a real Miniflare persistence tree: a modifier of
// 8f14e45f-ceea-467a-9e73-8bdb0d1e1c2b and a class of Room produced the
// directory 8f14e45f-ceea-467a-9e73-8bdb0d1e1c2b-Room.
export function parseUniqueKey(uniqueKey: string): { resourceId: string; className: string } {
  const split = uniqueKey.lastIndexOf('-')
  if (split <= 0 || split === uniqueKey.length - 1) {
    throw new HobbyError(
      'internal',
      `namespace directory "${uniqueKey}" is not <uniqueKeyModifier>-<ClassName>`,
      'Durable Object storage directories are named by @hobby.sh/compute from the resource id and the class name. A directory that does not match was not created by hobby.'
    )
  }
  return {
    resourceId: uniqueKey.slice(0, split),
    className: uniqueKey.slice(split + 1),
  }
}

function isObjectFile(entry: string): boolean {
  if (entry === ALARM_DB_FILENAME) {
    return false
  }
  if (!entry.endsWith(OBJECT_SUFFIX)) {
    // Excludes -wal and -shm, which end in .sqlite-wal and .sqlite-shm.
    return false
  }
  return OBJECT_ID_PATTERN.test(entry.slice(0, -OBJECT_SUFFIX.length))
}

// One namespace, fully described. Reads the alarm table once and joins it onto
// the file listing, rather than asking per object, because the table is per
// namespace and a per-object query would open the same database N times.
export function describeNamespace(doRoot: string, uniqueKey: string): NamespaceSummary {
  const namespaceDir = join(doRoot, uniqueKey)
  const { resourceId, className } = parseUniqueKey(uniqueKey)

  if (!existsSync(namespaceDir)) {
    throw new HobbyError(
      'resource_not_found',
      `no Durable Object storage at ${namespaceDir}`,
      'A namespace that has never had an object addressed has no directory yet. That is not an error unless you expected data.'
    )
  }

  const alarmsByActor = new Map(
    readPendingAlarms(namespaceDir).map((alarm) => [alarm.actorId, alarm])
  )

  const objects: ObjectSummary[] = []
  for (const entry of readdirSync(namespaceDir)) {
    if (!isObjectFile(entry)) {
      continue
    }
    const id = entry.slice(0, -OBJECT_SUFFIX.length)
    const stats = statSync(join(namespaceDir, entry))
    const alarm = alarmsByActor.get(id)
    objects.push({
      id,
      name: alarm?.actorName ?? null,
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      alarmAtMs: alarm?.scheduledAtMs ?? null,
    })
  }

  objects.sort((a, b) => a.id.localeCompare(b.id))

  // Read from the table rather than from `objects`, so that an alarm belonging
  // to an object whose file has been removed still counts. That row is exactly
  // the case the mirror must still wake for: workerd will reconstruct the
  // object when it fires.
  let nextAlarmAtMs: number | null = null
  for (const alarm of alarmsByActor.values()) {
    if (nextAlarmAtMs === null || alarm.scheduledAtMs < nextAlarmAtMs) {
      nextAlarmAtMs = alarm.scheduledAtMs
    }
  }

  return {
    uniqueKey,
    className,
    resourceId,
    objectCount: objects.length,
    totalSizeBytes: objects.reduce((total, object) => total + object.sizeBytes, 0),
    nextAlarmAtMs,
    objects,
  }
}

// Just the namespace directories, without describing what is in them.
//
// The guard runs on every hibernation tick, once per worker, and only needs to
// know which schedules to read. describeNamespace stats every object file,
// which at ten thousand objects is ten thousand syscalls to answer a question
// that one query per namespace answers.
export function namespaceDirs(doRoot: string): string[] {
  if (!existsSync(doRoot)) {
    return []
  }
  return readdirSync(doRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(doRoot, entry.name))
    .sort()
}

// Every namespace under a worker's do/ directory. A missing directory means
// no Durable Object has ever been addressed, which is an empty list rather
// than a failure: a worker that declares a class but has never been called
// has nothing on disk.
//
// A directory this cannot make sense of is skipped with a warning rather than
// thrown, for the same reason tickOnce contains a failure per namespace: this
// backs a listing in Studio and in `hobby do ls`, and one stray directory must
// not blank the whole page. Asking for that namespace by name still throws,
// because then the caller named something specific and deserves to be told it
// is wrong.
//
// This is not hypothetical. Running the finished package against a real
// Miniflare tree written without a uniqueKeyModifier produced directories
// named `-Room` and `-Presence`, and the first one aborted the listing. Under
// hobby the modifier is always the owning resource's UUID so those names
// cannot occur, but "cannot occur" is a poor reason for a listing to be
// fragile.
export function listNamespaces(doRoot: string): NamespaceSummary[] {
  if (!existsSync(doRoot)) {
    return []
  }
  const summaries: NamespaceSummary[] = []
  for (const entry of readdirSync(doRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    try {
      summaries.push(describeNamespace(doRoot, entry.name))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`durable objects: skipping ${join(doRoot, entry.name)}: ${message}`)
    }
  }
  return summaries.sort((a, b) => a.uniqueKey.localeCompare(b.uniqueKey))
}
