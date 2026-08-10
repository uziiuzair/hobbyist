// One sqlite handle, whichever runtime is holding it.
//
// ADR 0006 makes Bun the runtime, and the rule that came with it was to write
// against Node-compatible APIs so switching runtimes stays a build change.
// store.ts followed that rule exactly and it still was not enough: `node:sqlite`
// IS a Node API, Bun simply does not implement that particular built-in, and
// `bun packages/cli/bin/hobby.js` died on `No such built-in module: node:sqlite`
// before printing a line of help. The rule protects against reaching for
// Bun-only APIs; it cannot protect against Node built-ins Bun has not shipped.
//
// So this is the one file that knows there are two sqlite implementations, and
// it exists to keep that knowledge out of store.ts.
//
// The API surface store.ts uses is small enough to make this honest rather than
// a compatibility layer with opinions: open, exec, prepare, close, and a
// statement's get/all/run. Anything beyond that should be added here
// deliberately, after checking it means the same thing on both sides.
//
// createRequire rather than a dynamic import, because openStore is synchronous
// and the whole store API is built on that. An `await import` here would make
// opening the database async and push that up through every caller, which is a
// large change to accommodate a small one.

import { createRequire } from 'node:module'

const requireModule = createRequire(import.meta.url)

export interface SqliteStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

export interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

type RawDatabase = SqliteDatabase

// The difference that matters, and the reason this is a wrapper rather than a
// type alias: node:sqlite returns `undefined` for a row that does not exist,
// bun:sqlite returns `null`. Every lookup in store.ts is written
// `row === undefined ? null : rowToProject(row)`, so under Bun a miss would
// have skipped that branch and called rowToProject(null): a wrong answer, not
// a crash, on the most common read in the codebase. Normalising here means
// store.ts keeps one meaning of "not found" and never learns there were two.
function normalise(db: RawDatabase): SqliteDatabase {
  return {
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    prepare(sql) {
      const statement = db.prepare(sql)
      return {
        get: (...params) => statement.get(...params) ?? undefined,
        all: (...params) => statement.all(...params),
        run: (...params) => statement.run(...params),
      }
    },
  }
}

export function isBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

export function openDatabase(path: string): SqliteDatabase {
  if (isBun()) {
    const { Database } = requireModule('bun:sqlite') as { Database: new (path: string) => RawDatabase }
    return normalise(new Database(path))
  }
  const { DatabaseSync } = requireModule('node:sqlite') as { DatabaseSync: new (path: string) => RawDatabase }
  return normalise(new DatabaseSync(path))
}

// The second divergence this file exists to hide: node:sqlite spells the
// read-only flag `readOnly`, bun:sqlite spells it `readonly`. A caller that
// guessed wrong would not fail loudly, it would silently get a writable
// handle, which is the one thing a read-only open is for.
//
// @hobby.sh/do is the caller. It reads a Durable Object namespace's
// metadata.sqlite to find pending alarms while the runtime is stopped, and it
// must not perturb what it observes: a read-write open of a WAL database can
// create sidecar files and checkpoint the log, so the act of looking would
// change the thing being looked at. See
// docs/durable-objects/specs/2026-08-10-the-alarm-mirror-and-object-catalog.md.
//
// Verified against a real Miniflare-written WAL database with live -wal and
// -shm sidecars present: a read-only open succeeds and reads current rows.
export function openDatabaseReadOnly(path: string): SqliteDatabase {
  if (isBun()) {
    const { Database } = requireModule('bun:sqlite') as {
      Database: new (path: string, options: { readonly: boolean }) => RawDatabase
    }
    return normalise(new Database(path, { readonly: true }))
  }
  const { DatabaseSync } = requireModule('node:sqlite') as {
    DatabaseSync: new (path: string, options: { readOnly: boolean }) => RawDatabase
  }
  return normalise(new DatabaseSync(path, { readOnly: true }))
}
