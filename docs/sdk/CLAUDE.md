# `docs/sdk/` client libraries

**Status:** PROPOSED. Nothing built. **Phase 3.** React first.

Client-side helpers for applications that run against a Hobbyist project.

## Why this is last, and why it might not happen

An SDK is only worth writing once there is something to talk to that is not
already served by an existing client. Postgres has excellent clients: `pg`,
Drizzle, Prisma, Kysely. **Wrapping them adds nothing and creates lock-in of
exactly the kind ADR 0003 exists to prevent.**

So the SDK is not a database client. It is only justified by things that have no
good client yet, which by Phase 3 means buckets and compute.

If Phase 3 arrives and there is still no capability that needs one, **the correct
outcome is to delete this folder**, per the root `CLAUDE.md` agreement that
deleting a feature beats deferring it.

## Plausible scope, to be argued when it is real

- Bucket access from the browser: uploads, signed URLs, progress
- Typed access to a project's resources from an app deployed on the same box
- React bindings over the above: hooks, suspense-friendly, no global client
  singleton

## Out of scope

- **A Postgres client.** Use `pg`. Use Drizzle. We are not competing with them
  and wrapping them would make leaving harder.
- An ORM, a query builder, a migration tool
- Auth helpers. There is no end-user auth service to help with, by design.
- Framework integrations beyond React until React is actually being used daily

## Open question

The one that decides whether this folder lives: **what can an application do with
an SDK that it cannot do with a connection string and `fetch`?** If there is no
convincing answer at Phase 3, there is no SDK.
