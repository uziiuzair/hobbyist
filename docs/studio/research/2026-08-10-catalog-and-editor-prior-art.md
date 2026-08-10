# Catalog introspection and SQL editor prior art

Status: NOTES. A survey of what can be taken rather than written. No decision
made, and M4 has not started.
Date:   2026-08-10

`docs/studio/CLAUDE.md` sets the bar at "enough that you stop reaching for
another tool for routine work", and lists a read-only schema view among the
Phase 1 deliverables. Reading `pg_catalog` correctly is unglamorous, large, and
already solved several times in permissively licensed TypeScript.

## The catalog layer: take `pg-meta`, not `postgres-meta`

Supabase ships the same catalog logic in two shapes, and the difference matters
to us.

**`supabase/postgres-meta`** (Apache 2.0, TypeScript) is a standalone Fastify
service. `src/lib/` holds one module per catalog object: `PostgresMetaTables.ts`,
`PostgresMetaColumns.ts`, `PostgresMetaPolicies.ts`, `PostgresMetaRoles.ts`,
`PostgresMetaTriggers.ts`, `PostgresMetaIndexes.ts`, `PostgresMetaTypes.ts`,
`PostgresMetaExtensions.ts`, `PostgresMetaPublications.ts`, plus column and table
privilege modules. Dependencies include `pg`, `pg-format` and `pgsql-parser`.

**`supabase/supabase` at `packages/pg-meta`** is the same coverage as a package
of query builders with no server attached: `pg-meta-tables.ts`,
`pg-meta-columns.ts`, `pg-meta-policies.ts` and so on, with a vendored
`pg-format` and a `sql/` directory of the actual catalog queries.

The service shape exists because Supabase Studio talks to projects it does not
co-host, so it needs an HTTP hop. Ours does not. `docs/studio/CLAUDE.md` puts
"talking to Postgres directly" explicitly out of scope for Studio, and the root
`CLAUDE.md` names the daemon API as the only control surface. Adopting
`postgres-meta` would add a fourth control surface and break that structurally.
Adopting `packages/pg-meta` gives the daemon the queries and keeps the seam.

This also bears on the open question in `docs/studio/CLAUDE.md` about whether the
schema view reads `information_schema` on every load or the daemon caches it.
These queries hit `pg_catalog` rather than `information_schema`, which is
meaningfully faster, and having them in the daemon is what makes caching a later
choice rather than a prerequisite.

A smaller alternative is `neondatabase/psql-describe`, which ports psql's `\d`
family to JavaScript. Its licence reads NOASSERTION on the GitHub API, so it
cannot be vendored without checking the actual file.

## `lite-studio` is Supabase conceding the point

`supabase/supabase` now contains `apps/lite-studio` alongside `apps/studio`. Its
`package.json` lists five runtime dependencies plus React: React Router 7, and
the in-repo `ui` and `ui-patterns` packages. It ships its own Dockerfile.

`apps/studio` is the reference for what a database dashboard can be. This is the
reference for what one costs to maintain, written by the people paying that cost.
Read it before M4, because it is the closest thing to a statement of which parts
of a Studio are load-bearing.

Note also that `supabase/ui` as a standalone repository is **archived** as of
March 2024. The living component library is `packages/ui` and `packages/ui-patterns`
inside the monorepo, under the repository's Apache 2.0 licence. Anything
pointing at the old repository is pointing at a corpse.

## The SQL editor: `local-explorer-ui`

`cloudflare/workers-sdk` at `packages/local-explorer-ui` is Wrangler's local
D1, KV and R2 browser. Dependencies name the whole recipe: `@codemirror/lang-sql`
with `@codemirror/autocomplete` for the editor, `@cloudflare/kumo` and
`@base-ui/react` for components, `@tanstack/react-router`, `@dnd-kit/*` for
column reordering, `@phosphor-icons/react`, Tailwind 4 via `@tailwindcss/vite`.

It is small, current, and solves the same problem at the same scale we are: a
local explorer for a developer's own resources, not a multi-tenant console. That
makes it a better structural reference than `apps/studio`, which carries an
enormous amount of Supabase-cloud-specific surface.

`cloudflare/kumo` itself is MIT, roughly 3.3k stars, documented at `kumo-ui.com`,
and pushed daily. It is a genuine alternative to whatever component base Studio
settles on, and unlike most component libraries it has a real product built on it
that we can read.

## Advisors: `splinter`

`supabase/splinter` is Supabase's security and performance linter, written as
plain PLpgSQL views. No extension to install, no service to run: query the views,
render the findings. Unused indexes, missing foreign key indexes, tables without
RLS, security definer views, and similar.

This is a large amount of perceived product value for the cost of running some
queries, and it fits the "legible without leaving the browser" argument in
`docs/studio/CLAUDE.md` better than most features of comparable size.

**Licence caution:** the GitHub API reports no licence for the repository. It
must be read and reimplemented rather than vendored, unless a licence appears.

`supabase/index_advisor` is the adjacent tool and is a real Postgres extension
under the PostgreSQL licence. The root `CLAUDE.md` forbids required extensions
for core function, so it could only ever be an optional enhancement that Studio
detects and offers.

## Not applicable, recorded so it is not rediscovered

- `supabase/auth`, `supabase/realtime`, `supabase/edge-runtime`: all named in the
  root `CLAUDE.md` out-of-scope list.
- `cloudflare/workers-oauth-provider`: end-user auth as a service, out of scope
  per ADR 0008's operator-credential model.
- `supabase/supavisor`: a connection pooler, in Elixir, and it does not wake
  anything. `docs/proxy/CLAUDE.md` already leaves pooling as an open question and
  this does not answer it.

## Open questions this raises

- Does `packages/pg-meta` get vendored, forked, or read and reimplemented? It is
  Apache 2.0 so all three are permitted, and vendoring a moving target from a
  monorepo is the awkward option.
- Does the daemon expose catalog introspection as typed endpoints, or as one
  generic "describe" endpoint? `docs/studio/CLAUDE.md` says Studio renders the API
  and does not extend it, which pushes toward typed endpoints and therefore
  toward the CLI and MCP getting them for free.
