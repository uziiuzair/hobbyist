# `docs/portability/` eject and the right to leave

**Status:** BUILT. `hobby eject <project>`, `hobby eject --release` and
`hobby adopt` are `ejectRoute` and `adoptRoute` in
`packages/cli/src/daemon/routes.ts`, rendering the compose file with
`renderCompose` there; the postgres, app, worker and queue kinds all eject
(`packages/cli/test/eject-compute.test.ts`). Verified end to end against real
Docker on 2026-08-08. The body below is the original scope guard.

The capability that makes the entire project honest.

It is in M1 because ADR 0003 says its invariants are enforced by a test suite
that runs on every commit rather than by intention, and a test suite has to exist
before there is anything capable of breaking it. Retrofitting a portability
guarantee onto a system that was never tested for it is how the guarantee quietly
stops being true.

**Every resource kind has to be ejectable, and that gets harder with each phase.**
A `postgres` resource ejects to a compose file and a data directory. An `app`
also needs its `Dockerfile` and its Caddy configuration (ADR 0009), because an
ejected app that no longer serves is not an ejected app. A `bucket` needs its
object store config and its data. **A kind that cannot be ejected does not
ship.**

## The promise

**You can always leave, in one command, at any time.**

```
hobby eject <name>
```

emits a plain `docker-compose.yml` plus the data directory, stops managing the
instance, and gets out of the way. From that moment Hobbyist is uninstallable
with nothing lost.

**2026-10-28 amendment.** "Plus the data directory" means *named*, not
copied: the compose file mounts hobby's own directories under
`$HOBBY_HOME/projects/<name>` in place, and the file's header says so
(issue #180). After `--release`, `hobby rm <name>` forgets the project and
leaves those directories alone (issue #172); uninstalling hobby by deleting
`$HOBBY_HOME` still deletes them, so move them and edit the volume paths
first. Without `--release` the file is a preview of a project hobby still
manages, and starting it beside hobby ran a second postgres on the live
data directory (issue #174): every service in the preview is behind the
compose profile `hobby-released`, so `docker compose up` starts nothing
from it until `--release` has produced the file that is meant to be started.

## Why this is a capability and not a footnote

This project exists because its author objects to vendor lock-in. A tool built on
that objection which quietly becomes hard to leave would be worse than the
platforms it criticises, because it made the promise out loud.

The guarantee also has to be enforced by design rather than intention, which is
why it constrains other capabilities:

- **The data directory is always a plain, unmodified Postgres data directory.**
  Not a custom format, not a page-versioned blob store, not a proprietary
  manifest. See `docs/decisions/0003`.
- **`pg_dump` always works**, at any moment, without Hobbyist running.
- **Pointing a stock `postgres` binary at the directory always works,** where
  "the directory" is the `18/docker` subdirectory beneath the host directory
  Hobbyist creates and bind-mounts, not that directory itself. Postgres 18's
  official image refuses to start when the bind mount lands directly at what
  used to be PGDATA; the corrected mount is the postgres home directory, and
  the image places the real data directory in a subdirectory named after the
  major version. See `docs/decisions/0003`'s 2026-08-07 amendment, found by
  running the integration suite against real Docker rather than the fake
  runtime the unit tests drive. `resolvePgdataPath` in
  `packages/core/src/config.ts` is the one place that subdirectory pattern is
  derived rather than hardcoded.

Any feature that would break one of those three loses to the guarantee. There is
no negotiation on this, and that is deliberate: this is the one place where being
inflexible is the point.

## In scope

- `hobby eject` and the artifacts it emits
- The data-format guarantee, and a test suite that proves it on every commit
  rather than asserting it in a README
- Import: adopting an existing Postgres data directory into Hobbyist management,
  which is eject in reverse and equally important
- Documenting exactly what is lost on eject, honestly. Branch relationships and
  hibernation state do not survive, and saying so plainly is part of keeping the
  promise

## Out of scope

- Migration tooling for other platforms. Getting off Neon or Supabase is
  `pg_dump` and a restore, and pretending otherwise would be inventing a problem.

## Marketing note

`hobby eject` is the best asset this project will ever have, because no
competitor dares ship it. It belongs in the README's first screen, not buried in
a reference page.

## 2026-11-17 amendment: `hobby import`, the logical way in

**Status:** BUILT. `hobby import <project>` copies an existing Postgres (Neon,
Supabase, RDS, a local server) into a hobby postgres resource with stock
`pg_dump` and `pg_restore`: `runImport` in
`packages/cli/src/daemon/import.ts` behind `POST /v1/import`, the CLI verb in
`packages/cli/src/cli/import.ts`, the MCP tool `hobby_import`
(`importTool`, `packages/mcp/src/tools.ts`), the source parser and redactor
in `packages/pg/src/import-source.ts`. It is the logical-dump sibling of
issue #179 (adopting a raw data directory), and does not close it.

**How it squares with "Out of scope: migration tooling for other platforms".**
That line says getting off Neon or Supabase is `pg_dump` and a restore. This is
exactly that and nothing more: no schema translation, no provider API, no
continuous sync. What it adds is running the two tools from the target's own
image so the host needs no client tools and the `pg_dump` version is right,
and refusing the cases that would otherwise fail halfway.

Decisions, each grounded in the code named:

- **No logical replication.** Xata's migration-tool (read, not copied) follows
  the dump with a subscription. A subscription is a connection held open
  against the target for as long as it exists, which keeps it awake: the wedge
  (ADR 0007) loses to a convenience. An import is one-shot, and `pg_dump` runs
  with `--no-subscriptions` so a source's own subscriptions are not carried in.
- **One throwaway container from the target's image** (`importDockerArgs`,
  `--pull never`, the project's network, `host.docker.internal:host-gateway`).
  The dump lives in the container's filesystem and goes with `--rm`: nothing
  on the host to clean up or chown. `pg_dump` cannot dump a newer server, so
  the script compares the source's `server_version_num` with its own major
  before dumping and the daemon refuses with both versions and issue #2.
- **The source string is a credential.** Never an argument (the CLI reads
  stdin, `--from-file` or `--from-env`); never in any argv, container
  environment or host file. The daemon renders a libpq service file and writes
  it to the container's stdin; the script copies it into a 0700 directory
  inside the container and every tool is told only `service=source`. All tool
  output passes `redactor` before reaching an error, response or log line,
  and parse errors name keywords, never values. Tests: `import.test.ts`
  asserts the argv, the response and the daemon log hold no secret.
- **MCP takes the source by reference only** (`sourceEnv`, `sourceFile`),
  resolved in the MCP server process by the CLI's own `resolveImportSource`.
  A literal argument would put the password into the conversation, the
  client's transcript on disk and the provider's context, and would invite a
  model to ask a person to paste it. A reference to a variable or file that is
  not a connection string is refused without quoting it, and an import only
  reads from its source.
- **No flag to restore over a non-empty database.** A target holding any
  table, view, sequence or function outside an extension (`EMPTY_SQL`) is
  refused with 409. Restoring into a populated database either merges two
  datasets unpredictably or, with `pg_restore --clean`, drops the user's
  objects first: the "losing data quietly" this project refuses to ship. A new
  project, a new `--resource`, or a snapshot and a manual empty cover every
  real case. Extensions created with `hobby pg ext add` do not count, so the
  prepare-then-import path works.
- **Awake while it runs, asleep after.** An `ActivityTracker.open` handle on
  the target for the duration (the hibernator never sleeps a resource with an
  open handle), the restore session named `HOBBY_APPLICATION_NAME` so the
  pre-sleep guard ignores it, and `holdProjectExclusive` so a snapshot cannot
  interleave. The idle clock starts when the handle closes.
- **Schemas.** Default: everything `pg_dump` would dump. `--schema` restricts
  (the Supabase path, `public`); `pg_dump` then dumps no extensions, so the
  script adds `--extension` for each source extension the image ships and
  creates its schema first (Supabase keeps them in `extensions`). Without a
  restriction, an extension the image lacks is refused before any restore.
- **Errors.** `pg_restore` continues past errors by default and the report
  lists up to 20 (`restore.messages`); the CLI exits 1, like `pg_restore`.
  `--strict` is `--single-transaction --exit-on-error`. A project or resource
  the import created is removed when it fails before restoring.
- **Ownership.** `--no-owner --no-acl`: every object belongs to the target's
  superuser and the source's roles need not exist. Policies naming roles are
  the common remaining error and are reported.

**Verified** on 2026-11-17, Apple Silicon Mac, Docker Desktop, plain containers
only (no daemon): `runImport` compiled and driven with a hand-built context
against a `postgres:16` source on port 37432 (three tables, 3734 rows, four
contrib extensions, three roles, a policy) into a `postgres:18-alpine` target:
3 tables and 3734 rows restored, owners mapped to the target superuser, the
policy reported. Also: a second import into the same database refused as not
empty; a PostgreSQL 18 source with a `postgres:16-alpine` image refused before
dumping; a wrong password reported with the password absent; a Supabase-shaped
database (`auth`, `extensions` schemas) imported with `--schema public`, with
`uuid-ossp` and `pgcrypto` landing in `extensions` and the foreign key into
`auth.users` reported; `--strict` rolled back to an empty database.

**Not verified:** a real Neon or Supabase source (the guide's provider notes
come from their documentation), Linux `host-gateway` reachability of a
loopback-only source, an image with an older libpq, which may cap service file lines at 256
bytes (a very long password or `options` value; not checked), an
interrupted import (the container keeps running if the daemon dies; the
target is then partly restored), and the CLI and MCP against a running daemon.
