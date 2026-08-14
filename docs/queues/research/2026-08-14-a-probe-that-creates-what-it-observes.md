# A probe that creates the thing it claims to observe

Status: NOTES. Found by review on 2026-08-14, in queue code that was written the
day before. Filed because it is the third instance of one bug class in this
repo, and the first one where the check actively lies rather than merely
failing to check.
Date:   2026-08-14

## The contract

`packages/core/src/kinds.ts` defines `probe` as the answer to a question the
store cannot answer:

> Observed reality for reconcile: is the thing INSIDE the container actually
> serving, not merely running?

and records why the distinction exists at all: a container's published port
accepts TCP the instant it starts, seconds before Postgres finishes crash
recovery, so `docker inspect` reports `running` for a database that cannot
answer a query.

## The bug

`packages/queue/src/kind.ts`'s `probe` was written as:

```ts
async probe(ctx, resource) {
  try {
    openQueueDb(pathFor(ctx, resource)).close()
    return true
  } catch {
    return false
  }
}
```

which reads as "open it and see". But `openQueueDb`
(`packages/queue/src/schema.ts`) is:

```ts
export function openQueueDb(path: string): SqliteDatabase {
  mkdirSync(dirname(path), { recursive: true })
  const db = openDatabase(path)
  db.exec(SCHEMA)          // CREATE TABLE IF NOT EXISTS ...
  return db
}
```

It creates the directory, creates the file, and creates the table. So the probe
did not observe a queue. It created a queue and then reported that a queue
existed. A queue that had never been started probed `true`. So did one that had
just been destroyed.

## Why no test caught it

The probe test called `start()` first. Against that fixture, an implementation of

```ts
async probe() { return true }
```

passes identically. The test asserted the true thing in a world where nothing
could make it false.

## The fix

Observe without creating, using the honest primitive the repo already had:

```ts
if (!existsSync(path)) return false
const db = openDatabaseReadOnly(path)
try { /* confirm the messages table exists */ } finally { db.close() }
```

`openDatabaseReadOnly` exists in `packages/core/src/sqlite.ts` for exactly this
reason, and its comment says so: `@hobby.sh/do` reads a Durable Object's alarm
schedule with it because "a read-write open of a WAL database can create sidecar
files and checkpoint the log, so the act of looking would change the thing being
looked at".

The fix was verified by mutation rather than by argument: the compiled `probe`
was hand-patched to `return true`, two tests failed with `true !== false`, and
the source was rebuilt. The tests that now exist are:

- probe is false for a queue that was never started,
- probe is false after `destroy`,
- probe is true after `start`,
- **a probe on a never-started queue does not create a file**, which is the one
  that pins the actual defect.

## The pattern, which is the reason to file this

Three instances in this repo, all the same shape:

| Where | The cheap check | Why it lies |
|---|---|---|
| Postgres readiness (`kinds.ts`) | TCP connect to the published port | Docker's port proxy binds the host port whether or not anything inside is listening |
| `app` and `worker` readiness (`worker.ts`, `app.ts`) | the same connect | the same reason, rediscovered for two more kinds |
| queue readiness (this note) | open the sqlite file | opening a sqlite file creates it |

In every case the cheapest way to ask "is it there?" is an operation that makes
it be there. And in every case the false positive is invisible in tests, because
tests set the thing up before asking.

The first two were found by running containers. This one was found by reading,
and only because a reviewer was told the type system would not help.

## The wider point

The compiler cannot catch any of these. This repo has no exhaustiveness on
`ResourceKind` or `ResourceState`, `as` casts silence narrowing at the wire
boundary, and a template literal will accept `null` without complaint. That is
five distinct ways this codebase declined to warn its authors in a single day,
across two concurrent branches.

Four of those five are absences of checking. This one is a check that actively
reports the opposite of the truth, which is why it is worth its own note.

## See also

ADR 0014 (`docs/decisions/0014-resource-records-exist-before-code.md`) reached
the same conclusion from the other branch, on the same day, and its
"Consequences accepted" section names one of the five directly: adding
`undeployed` to `ResourceState` produced zero compile errors, because
`correctedState` is an if/else chain ending in an unconditional
`return 'failed'`, so a future member will produce zero again. That record and
this one are two halves of one finding, and 0014's bullet points back here.
