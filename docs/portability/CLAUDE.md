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
