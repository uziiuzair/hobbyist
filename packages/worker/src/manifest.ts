// Reading the user's own `wrangler.toml` (or `wrangler.jsonc`), which is the
// point of the `worker` kind: the manifest is Cloudflare's, not ours, and a
// Worker that runs here should be the same Worker that would deploy there.
//
// We honour a documented subset and ignore the rest LOUDLY. Silently
// ignoring a key in a config file the user believes is authoritative is how
// a platform earns a reputation for lying: `routes` quietly dropped means an
// app that answers at a hostname the user never asked for, and a dropped
// binding means a runtime crash blamed on us.

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { HobbyError } from '@hobby.sh/core'

export interface WranglerDurableObject {
  binding: string
  className: string
}

// The binding name is the whole point of keeping this shape: it is what the
// producer's JS object must be bound to (`env.MY_QUEUE.send()`), and a queue
// name alone cannot rebuild it.
export interface WranglerQueueProducer {
  queue: string
  binding: string
}

// Absent tuning keys stay `null` here rather than being filled with a
// guessed default: the broker owns the defaults (DEFAULT_CONSUMER_OPTIONS in
// packages/queue/src/broker.ts), and baking a copy of them into the parser
// would create a second source of truth that drifts.
export interface WranglerQueueConsumer {
  queue: string
  maxBatchSize: number | null
  maxBatchTimeoutSeconds: number | null
  maxRetries: number | null
  retryDelaySeconds: number | null
  deadLetterQueue: string | null
}

export interface WranglerManifest {
  name: string | null
  main: string
  compatibilityDate: string
  compatibilityFlags: string[]
  vars: Record<string, string>
  kvNamespaces: string[]
  r2Buckets: string[]
  d1Databases: string[]
  queues: { producers: WranglerQueueProducer[]; consumers: WranglerQueueConsumer[] }
  durableObjects: WranglerDurableObject[]
  // Every top-level key we saw and did not act on, so the deploy can print
  // them. Sorted, so the output is stable between runs.
  ignored: string[]
}

// The keys we act on. Anything else at the top level lands in `ignored`.
const HONOURED = new Set([
  'name',
  'main',
  'compatibility_date',
  'compatibility_flags',
  'vars',
  'kv_namespaces',
  'r2_buckets',
  'd1_databases',
  'queues',
  'durable_objects',
])

// Keys we deliberately ignore, with the reason, so the deploy output can say
// why rather than just listing them. A user who sees `routes` ignored with no
// explanation reasonably concludes we are broken.
export const IGNORED_WITH_REASON: Record<string, string> = {
  routes: 'hostnames come from hobby: <resource>.<project>.<domain>',
  route: 'hostnames come from hobby: <resource>.<project>.<domain>',
  workers_dev: 'there is no workers.dev here; this is your box',
  account_id: 'has no meaning outside Cloudflare',
  triggers: 'scheduled workers are not built yet',
  observability: 'Cloudflare-side telemetry; use `hobby logs`',
  placement: 'smart placement is a global-network feature; this is one box',
  limits: 'not enforced here (ADR 0004: no metering, no quotas)',
  // Nested under `queues`, not a top-level key, so it can never be found by
  // the ignored-key scan below. `queuesFrom` pushes the literal string
  // 'queues.consumers.max_concurrency' into `ignored` by hand when it sees
  // the key, which is what makes this entry reachable at all.
  'queues.consumers.max_concurrency': 'one box, one consumer container; honoured as 1',
  // A producer entry is dropped, not adapted, when `binding` is missing or
  // not a string: `queuesFrom` reports it the same way it reports
  // `max_concurrency`, by hand, since a malformed binding array element
  // never reaches the top-level scan either.
  'queues.producers.binding':
    'a producer with no binding has nothing to call send() on, so the queue it names is declared but unreachable from code',
  // Wrong-typed tuning keys are worse than absent ones: an absent key gets
  // the broker's own default and the deploy output never mentions it, but a
  // wrong-typed key looks like it was honoured while it was quietly dropped
  // and the default applied underneath it anyway.
  'queues.consumers.max_batch_size':
    'not a number; ignored, so the broker default of 5 messages per batch applies instead of the value written',
  'queues.consumers.max_batch_timeout':
    'not a number; ignored, so the broker default of 1 second applies instead of the value written',
  'queues.consumers.max_retries':
    'not a number; ignored, so the broker default of 2 retries applies instead of the value written',
  'queues.consumers.retry_delay':
    'not a number; ignored, so retries fire with no delay instead of the value written',
  'queues.consumers.dead_letter_queue':
    'not a string queue name; ignored, so this consumer ends up with no dead letter queue configured',
}

// JSONC, the format wrangler.jsonc actually uses. Comments only, no trailing
// commas, because that is what wrangler itself accepts and inventing a looser
// parser would accept files wrangler rejects.
//
// String-aware on purpose: a `//` inside a string literal (a URL, most
// obviously) is not a comment, and stripping it would corrupt the value.
export function stripJsonComments(input: string): string {
  let out = ''
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    const next = input[i + 1]

    if (inLine) {
      if (ch === '\n') {
        inLine = false
        out += ch
      }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += ch
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, key: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string').concat(
    // A binding array in wrangler is a list of objects, not strings, so the
    // shape depends on the key. `binding` is the field every one of them uses.
    value
      .filter(isRecord)
      .map((entry) => entry[key])
      .filter((entry): entry is string => typeof entry === 'string')
  )
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    // Everything a Worker sees in env is a string unless it is JSON, and
    // wrangler itself stringifies numbers and booleans here.
    if (typeof entry === 'string') out[key] = entry
    else if (typeof entry === 'number' || typeof entry === 'boolean') out[key] = String(entry)
  }
  return out
}

function durableObjectsFrom(value: unknown): WranglerDurableObject[] {
  if (!isRecord(value)) return []
  const bindings = value['bindings']
  if (!Array.isArray(bindings)) return []
  const out: WranglerDurableObject[] = []
  for (const entry of bindings) {
    if (!isRecord(entry)) continue
    const binding = entry['name'] ?? entry['binding']
    const className = entry['class_name'] ?? entry['className']
    if (typeof binding === 'string' && typeof className === 'string') {
      out.push({ binding, className })
    }
  }
  return out
}

// A tuning key that is present but the wrong JS type is a worse silence than
// an absent one: the value is still dropped and the broker's default still
// applies, but the user wrote a value and has no way to know it never took
// effect. `flagged` collects the manifest keys for that, same as
// `max_concurrency` below, so `queuesFrom` can report every one of them
// through the one path `IGNORED_WITH_REASON` already renders.
function numberOrFlag(entry: Record<string, unknown>, tomlKey: string, flagged: Set<string>): number | null {
  const value = entry[tomlKey]
  if (value === undefined) return null
  if (typeof value === 'number') return value
  flagged.add(`queues.consumers.${tomlKey}`)
  return null
}

function stringOrFlag(entry: Record<string, unknown>, tomlKey: string, flagged: Set<string>): string | null {
  const value = entry[tomlKey]
  if (value === undefined) return null
  if (typeof value === 'string') return value
  flagged.add(`queues.consumers.${tomlKey}`)
  return null
}

// `ignored` is mutated in place: everything this function flags (a missing
// producer binding, a wrong-typed tuning key, `max_concurrency`) lives
// nested inside `queues`, not at the top level, so the ordinary "key we
// didn't act on" scan in parseWranglerManifest can never see any of it.
// This is the one place that can, which is why it reports these directly
// rather than through HONOURED/IGNORED_WITH_REASON's usual top-level path.
function queuesFrom(
  value: unknown,
  ignored: string[]
): { producers: WranglerQueueProducer[]; consumers: WranglerQueueConsumer[] } {
  if (!isRecord(value)) return { producers: [], consumers: [] }

  const flagged = new Set<string>()

  const producers: WranglerQueueProducer[] = []
  for (const entry of Array.isArray(value['producers']) ? value['producers'] : []) {
    if (!isRecord(entry)) continue
    const queue = entry['queue']
    if (typeof queue !== 'string') continue
    const binding = entry['binding']
    if (typeof binding === 'string') {
      producers.push({ queue, binding })
    } else {
      // Still dropped: nothing downstream can call send() on a producer
      // with no binding name. The change is that the deploy now says so.
      flagged.add('queues.producers.binding')
    }
  }

  const consumers: WranglerQueueConsumer[] = []
  for (const entry of Array.isArray(value['consumers']) ? value['consumers'] : []) {
    if (!isRecord(entry)) continue
    const queue = entry['queue']
    if (typeof queue !== 'string') continue
    if ('max_concurrency' in entry) flagged.add('queues.consumers.max_concurrency')
    consumers.push({
      queue,
      maxBatchSize: numberOrFlag(entry, 'max_batch_size', flagged),
      maxBatchTimeoutSeconds: numberOrFlag(entry, 'max_batch_timeout', flagged),
      maxRetries: numberOrFlag(entry, 'max_retries', flagged),
      retryDelaySeconds: numberOrFlag(entry, 'retry_delay', flagged),
      deadLetterQueue: stringOrFlag(entry, 'dead_letter_queue', flagged),
    })
  }

  for (const key of flagged) ignored.push(key)

  return { producers, consumers }
}

export function parseWranglerManifest(text: string, format: 'toml' | 'json'): WranglerManifest {
  let raw: unknown
  try {
    raw = format === 'toml' ? parseToml(text) : JSON.parse(stripJsonComments(text))
  } catch (err) {
    throw new HobbyError(
      'usage',
      'could not read the wrangler manifest',
      err instanceof Error ? err.message : String(err)
    )
  }
  if (!isRecord(raw)) {
    throw new HobbyError('usage', 'the wrangler manifest is not an object')
  }

  const main = raw['main']
  if (typeof main !== 'string' || main.length === 0) {
    throw new HobbyError(
      'usage',
      'the wrangler manifest has no `main`',
      'hobby needs to know which file is the Worker entry point'
    )
  }

  const compatibilityDate = raw['compatibility_date']
  if (typeof compatibilityDate !== 'string' || compatibilityDate.length === 0) {
    throw new HobbyError(
      'usage',
      'the wrangler manifest has no `compatibility_date`',
      'workerd needs one to decide which runtime behaviours apply; set the date you developed against'
    )
  }

  // Not sorted yet: queuesFrom below can still push
  // 'queues.consumers.max_concurrency' into it.
  const ignored = Object.keys(raw).filter((key) => !HONOURED.has(key))
  const queues = queuesFrom(raw['queues'], ignored)
  ignored.sort()

  return {
    name: typeof raw['name'] === 'string' ? raw['name'] : null,
    main,
    compatibilityDate,
    compatibilityFlags: Array.isArray(raw['compatibility_flags'])
      ? raw['compatibility_flags'].filter((f): f is string => typeof f === 'string')
      : [],
    vars: stringMap(raw['vars']),
    kvNamespaces: stringArray(raw['kv_namespaces'], 'binding'),
    r2Buckets: stringArray(raw['r2_buckets'], 'binding'),
    d1Databases: stringArray(raw['d1_databases'], 'binding'),
    queues,
    durableObjects: durableObjectsFrom(raw['durable_objects']),
    ignored,
  }
}

export interface FoundManifest {
  manifest: WranglerManifest
  // Which file it came from, relative to the source directory, so the config
  // records what was actually read rather than what we guessed.
  file: string
}

// wrangler.jsonc is checked first, then wrangler.json, then wrangler.toml,
// which is wrangler's own precedence. A directory with both is not an error
// here (wrangler itself picks one), unlike Dockerfile-versus-wrangler at the
// `hobby deploy` level, where the two mean genuinely different kinds.
const CANDIDATES: Array<{ file: string; format: 'toml' | 'json' }> = [
  { file: 'wrangler.jsonc', format: 'json' },
  { file: 'wrangler.json', format: 'json' },
  { file: 'wrangler.toml', format: 'toml' },
]

export function findWranglerManifest(dir: string): FoundManifest {
  for (const candidate of CANDIDATES) {
    const path = join(dir, candidate.file)
    if (!existsSync(path)) continue
    return {
      manifest: parseWranglerManifest(readFileSync(path, 'utf8'), candidate.format),
      file: candidate.file,
    }
  }
  throw new HobbyError(
    'usage',
    `no wrangler manifest in ${basename(dir) || dir}`,
    'expected wrangler.jsonc, wrangler.json or wrangler.toml'
  )
}

// One line per ignored key, for the deploy to print. Keys we know about get
// their reason; anything else is reported as unrecognised rather than
// pretended away.
export function describeIgnored(ignored: string[]): string[] {
  return ignored.map((key) => {
    const reason = IGNORED_WITH_REASON[key]
    return reason === undefined ? `${key}: not recognised by hobby` : `${key}: ${reason}`
  })
}
