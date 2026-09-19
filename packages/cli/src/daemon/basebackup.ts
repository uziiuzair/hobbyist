// The online half of a snapshot: a running postgres copied with Postgres's
// own online backup, pg_basebackup, instead of being stopped and cloned.
// ADR 0016's 2026-09-19 note has the decision; takeOnlineSnapshot
// (snapshots.ts) is the only caller.
//
// Where it runs is dictated by pg_hba.conf, not chosen. The official image's
// initdb writes replication entries for the local socket and loopback only
// (`local replication all trust`, `host replication all 127.0.0.1/32 trust`
// and `::1/128`), and the entrypoint's appended `host all all all <method>`
// does not help: a physical replication connection is matched only by the
// keyword `replication` in the database column, never by `all` (check_db in
// Postgres's src/backend/libpq/hba.c, and the database field in the
// pg_hba.conf documentation). So pg_basebackup from the host, through the
// published port, or from a sibling container is refused, and the one place
// it is accepted is inside the resource's own container, over its socket.
// That is what the argument list below is, run through
// ComputeRuntime.execStream (packages/core/src/runtime.ts).
//
// Nothing is changed in the cluster to make this work: no pg_hba edit, no
// replication role, no slot left behind. A hobby postgres stays exactly the
// plain data directory ADR 0003 promises.

import { spawn } from 'node:child_process'
import { lstat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HobbyError, type ExecStream, type PostgresResource } from '@hobby.sh/core'
import type { DaemonContext } from './context.js'

// The socket directory the official image's server listens on
// (unix_socket_directories, which both the Debian and Alpine variants build
// with /var/run/postgresql). Named explicitly rather than left to libpq's
// compiled default so that what connects is unmistakably the local socket,
// the one route pg_hba lets a replication connection through, and never a
// TCP fallback.
export const POSTGRES_SOCKET_DIR = '/var/run/postgresql'

// The whole pg_basebackup invocation, as an argument array. Every flag is
// load-bearing:
//
//   --pgdata=-          the backup goes to stdout rather than a directory
//                       inside the container, which would cost the size of
//                       the database twice on the one disk and leave a copy
//                       to clean up if the daemon died halfway.
//   --format=tar        the only format that can go to stdout.
//   --wal-method=fetch  the WAL needed to reach consistency is collected at
//                       the end and written into the same tar, under
//                       pg_wal/. `stream`, the default, needs a second
//                       connection writing to a separate pg_wal.tar and is
//                       refused with --pgdata=- ("cannot stream write-ahead
//                       logs in tar mode to stdout"), and `none` would
//                       produce a cluster that cannot start. The cost of
//                       fetch is documented by pg_basebackup itself: the
//                       WAL must still be on the server when the backup
//                       ends, so a long backup of a busy database can fail
//                       if two checkpoints recycle the segment it started
//                       from. It fails loudly, with a non-zero exit, and
//                       takeOnlineSnapshot then leaves nothing behind.
//   --checkpoint=fast   start now, rather than waiting up to
//                       checkpoint_timeout for a spread checkpoint. Costs a
//                       burst of I/O; a snapshot the operator is waiting on
//                       is worth it.
//   --host              the local socket, see POSTGRES_SOCKET_DIR.
//   --username          the resource's own superuser (PostgresConfig's
//                       superuser, the image's POSTGRES_USER), which holds
//                       the REPLICATION attribute by being a superuser.
//   --no-password       never prompt. The socket is `trust`, so no password
//                       is needed, and a prompt with no terminal would hang.
//   --label             written into backup_label, so a restored cluster
//                       says which snapshot it came from.
//
// A cluster with a user-defined tablespace is refused by pg_basebackup in
// this shape ("can only write single tablespace to stdout, database has
// N"). Hobby never creates one, and a tablespace outside the mounted data
// directory would not be in an offline snapshot either; explainFailure below
// turns that refusal into advice rather than a raw message.
export function basebackupCommand(superuser: string, label: string): string[] {
  return [
    'pg_basebackup',
    '--pgdata=-',
    '--format=tar',
    '--wal-method=fetch',
    '--checkpoint=fast',
    `--host=${POSTGRES_SOCKET_DIR}`,
    `--username=${superuser}`,
    '--no-password',
    `--label=${label}`,
  ]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function detailOf(err: unknown): string {
  if (err instanceof HobbyError && err.hint !== undefined) {
    return err.hint
  }
  return errorMessage(err)
}

function explainFailure(resource: PostgresResource, err: unknown): HobbyError {
  const detail = detailOf(err)
  if (/single tablespace/i.test(detail)) {
    return new HobbyError(
      'conflict',
      `${resource.name} has a user-defined tablespace, which an online snapshot cannot stream`,
      `pg_basebackup writes one tar per tablespace and only one can go to stdout. take the snapshot without --online (${detail})`
    )
  }
  return new HobbyError('internal', `online backup of ${resource.name} failed`, detail)
}

export interface UnpackOptions {
  // Test seam for the extractor, defaulting to the system tar. Production
  // never sets it.
  spawnTar?: (dest: string) => { stdin: Writable; done: Promise<void>; kill(): void }
}

// The system tar, fed on stdin, extracting into dest. System tar rather than
// a dependency because it is already on every box this runs on (and on
// macOS, where the tests run, as bsdtar), because it is the tool that knows
// every corner of the ustar/pax headers pg_basebackup emits, and because the
// codebase has no tar library to reuse. An argument array, never a shell
// string. -p keeps the modes pg_basebackup recorded (PGDATA must be 0700 or
// 0750 or Postgres refuses to start); ownership is left to tar's own
// default, which is the extracting user's for a non-root daemon, the same
// as cloneTree gives an offline snapshot (docs/backups/CLAUDE.md's Linux
// ownership gap applies to both equally).
function defaultSpawnTar(dest: string): { stdin: Writable; done: Promise<void>; kill(): void } {
  const child = spawn('tar', ['-x', '-p', '-f', '-', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 64 * 1024) {
      stderr += chunk.toString('utf8')
    }
  })
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (err) => reject(new HobbyError('internal', 'tar could not be run', err.message)))
    child.once('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new HobbyError('internal', `tar exited ${code === null ? 'by signal' : code}`, stderr.trim() || 'no output'))
      }
    })
  })
  done.catch(() => {})
  return { stdin: child.stdin, done, kill: () => child.kill() }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

// Pipes an exec's tar into the extractor and succeeds only when all three
// parties agree it worked: the producer exited 0, the extractor exited 0, and
// the pipe between them did not break.
//
// None of the three is enough alone. A pg_basebackup that dies halfway
// closes stdout cleanly, and a tar cut off on a block boundary with no end
// marker is accepted by both GNU tar and bsdtar without complaint, so the
// extractor succeeding says nothing about whether it saw everything. The
// producer succeeding says nothing about whether the bytes landed. And the
// first failure of any of them must stop the others: an extractor that has
// died leaves pg_basebackup blocked on a full pipe forever unless it is
// cancelled, which is what the catch on each promise below is for.
export async function unpackExecTar(exec: ExecStream, dest: string, opts: UnpackOptions = {}): Promise<void> {
  const tar = (opts.spawnTar ?? defaultSpawnTar)(dest)
  const stopAll = (): void => {
    exec.cancel()
    tar.kill()
  }
  const piped = pipeline(exec.stdout as Readable, tar.stdin)
  const [produced, extracted, pipedResult] = await Promise.allSettled(
    [exec.done, tar.done, piped].map((promise) =>
      promise.catch((err: unknown) => {
        stopAll()
        throw err
      })
    )
  )
  // The producer's own error first: it carries pg_basebackup's stderr, which
  // says why, where a broken pipe or a tar complaint only says that.
  for (const result of [produced, extracted, pipedResult]) {
    if (result?.status === 'rejected') {
      throw result.reason
    }
  }
}

// Backs up one running postgres into `dest`, which becomes a PGDATA: the
// directory the image mounts at /var/lib/postgresql/18/docker, as
// resolvePgdataPath (packages/core/src/config.ts) names it. `dest` must not
// exist yet, the same rule cloneTree applies, so a leftover is never merged
// into.
//
// What comes out is not what an offline clone gives: it is a cluster that
// was running, plus the WAL to make it consistent, plus the backup_label
// pg_basebackup wrote. Its first start after a restore therefore runs
// recovery from that label to the backup's end point before it accepts
// connections. That is Postgres doing what the label exists for, and the
// label must never be removed: a cluster started without it would believe
// it crashed at the last checkpoint and silently skip the WAL that makes the
// copy consistent.
export async function basebackupPostgres(
  ctx: DaemonContext,
  resource: PostgresResource,
  dest: string,
  label: string,
  opts: UnpackOptions = {}
): Promise<void> {
  const runtime = ctx.runtime
  if (runtime.execStream === undefined) {
    throw new HobbyError(
      'runtime_unavailable',
      'this runtime cannot run a command inside a container, so an online snapshot is not possible',
      'take the snapshot without --online'
    )
  }
  if (await exists(dest)) {
    throw new HobbyError('internal', `online backup destination already exists: ${dest}`)
  }
  // 0700 because Postgres refuses to start on a data directory whose mode is
  // wider than 0750. The umask can only narrow it further, never widen it.
  await mkdir(dest, { recursive: true, mode: 0o700 })

  const exec = runtime.execStream(resource.config.containerName, basebackupCommand(resource.config.superuser, label))
  try {
    await unpackExecTar(exec, dest, opts)
  } catch (err: unknown) {
    throw explainFailure(resource, err)
  }

  // A last, independent check that what landed is a whole backup and not a
  // clean-looking prefix of one. pg_basebackup writes backup_label first and
  // global/pg_control last in the base archive ("include pg_control last",
  // basebackup.c), precisely so a reader of the stream can tell it finished.
  for (const required of ['backup_label', join('global', 'pg_control')]) {
    if (!(await exists(join(dest, required)))) {
      throw new HobbyError(
        'internal',
        `online backup of ${resource.name} is incomplete: ${required} is missing`,
        'the stream ended early without any process reporting an error. nothing was kept; retry the snapshot'
      )
    }
  }
}
