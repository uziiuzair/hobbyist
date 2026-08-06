# `docs/studio/` the web UI

**Status:** PROPOSED. Nothing built. Lands at **M4**, after waking feels good.

The dashboard. Managed platforms are chosen because provisioning is one click and
the database is legible without leaving the browser. This is our version of that,
and it competes on craft rather than surface area.

## The bar

**Enough that you stop reaching for another tool for routine work**, and no
further. Your audience already owns TablePlus, DataGrip and psql, and those are
excellent. A half-built table editor is worse than none.

Phase 1 ships:

- **Table data browsing** with paging, filtering and inline row edits
- **A real SQL editor**: saved snippets, history, keyboard-first
- **A read-only schema view**: tables, columns, types, keys, indexes
- **The control plane**: projects, resources, sleep state, wake, connection
  strings, size, connection counts

Visual DDL editing is deliberately **not** in Phase 1. A correct visual schema
editor has to generate safe migrations, and getting that wrong damages real data.

## Access and auth

**Network exposed, behind Caddy, gated by one operator credential.** See
`docs/decisions/0008`, which is a security decision rather than a UX one, and
`docs/decisions/0009` for the front door. The short version: one credential,
settable only by running a command on the box, argon2id, no signup, no email
reset, rate limited. The daemon binds to loopback and Caddy is the only thing
that reaches it.

## In scope

- The UI, its design system, and its interaction craft
- The session layer and its security properties
- Talking to the daemon HTTP API, and nothing else

## Out of scope

- **Talking to Postgres directly.** Studio holds no database credentials and
  opens no connections. Every query goes through the daemon API, which is what
  makes a query against a sleeping database wake it for free and keeps audit in
  one place.
- Any capability the CLI does not have. Studio renders the API, it does not
  extend it.
- End-user auth for other people's applications. See the out-of-scope list in the
  root `CLAUDE.md`.

## Open questions

- What does the SQL editor do when the query targets a sleeping database? Waking
  silently is probably right, but a several-second query with no explanation is
  worse than a "waking" state that is shown.
- Does the schema view read from `information_schema` on every load, or does the
  daemon cache it? Caching means invalidation; not caching means a query per
  page load against a database we may have just woken.
- How much of Studio works while every resource is asleep? Ideally all of the
  control plane, since sleep state should be readable without ending it.
