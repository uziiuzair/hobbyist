# `docs/studio/` the web UI

**Status:** BUILT, alpha. The React app is `packages/studio/src`
(`App.tsx`, `Workbench.tsx`, `ResourcePage.tsx`), served by the daemon on the
loopback API listener (`packages/cli/src/daemon/studio/static.ts`) behind the
operator credential (`studio/auth.ts`, `studio/session.ts`) and, since ADR
0018, API tokens (`studio/tokens.ts`). Browsing, SQL and schema work; it
cannot create an app or worker. The body below is the original scope guard.

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

## Amendment, 2026-10-29: multi-statement SQL (issue #115)

The query route (`POST /v1/resources/:id/query`, which the SQL editor uses)
sends a text with no parameters over the simple protocol, and the simple
protocol runs every statement in it and answers with one result per
statement. `runQuery` read `.rows` off that array, so every statement had
already committed when the route answered 400. `shapeQueryResult`
(`packages/pg/src/query.ts`) now returns the last statement's result, which
is what the text was written to see; the earlier statements run exactly as
they would in psql.

## Amendment, 2026-10-30: the QA lane's Studio bugs (issues #120 to #127)

Seven fixes from the 2026-10-16 QA pass, in one change. Each is grounded in
the file named.

- **Wake failures and SQL errors are told apart by the daemon's error code
  (#120).** `useWakeAwareRun` (`packages/studio/src/lib/useWaking.ts`) used
  to set `phase: 'error'` for any rejection, so a typo in the SQL editor
  rendered the "did not come up" banner. `isWakeFailure`
  (`packages/studio/src/lib/errors.ts`) is true only for `wake_failed` and
  `wake_timeout`, the two codes `getOrCreateWake` raises
  (`packages/pg/src/postgres.ts`, `packages/cli/src/daemon/context.ts`); a
  statement Postgres rejected arrives as `usage` from `toQueryError`
  (`packages/pg/src/query.ts`) with the SQLSTATE in `hint`. The branch is on
  the code, never on the HTTP status. `describeError` in the same module
  renders message plus hint, so the Sql, Tables and Schema views now show
  `syntax error at or near "selec" (SQLSTATE 42601)`.
- **The hardcoded "Recommended" security alerts are gone (#121).**
  `packages/studio/src/components/reusable/alert.tsx` is deleted and the
  section in `packages/studio/src/views/Projects.tsx` with it. Nothing
  replaces it: the home page shows the project list and the `MachineStrip`,
  both read from the API.
- **A project can be created from anywhere on the home page (#122).** A "New
  project" button sits beside the search in `Projects.tsx`; the empty-state
  button is wired; the no-match state says "No projects match". The create
  sequence is `createProjectWithDefaults`
  (`packages/studio/src/lib/createProject.ts`): `POST /v1/projects`, then a
  postgres named `primary` (`DEFAULT_POSTGRES_NAME`, mirroring
  `packages/core/src/names.ts`), and `DELETE /v1/projects/:name` if the
  postgres fails, the same sequence and rollback as `cmdNew`
  (`packages/cli/src/cli/commands.ts`). A "Start empty" checkbox is
  `hobby new --empty`; `--pin` is deliberately not offered in the form.
- **The login form asks for the password alone (#123).** `Login.tsx` has no
  username field and `api.login(password)` sends `{ password }`, which is
  all `loginHandler` (`packages/cli/src/daemon/studio/routes.ts`) reads.
  Enter submits whenever the password is non-empty.
- **A lost session returns to the login page (#124).** `request` in
  `packages/studio/src/api.ts` calls every `onUnauthorized` handler on a 401
  from any route except `/studio/login` and `/studio/token`; `AuthProvider`
  (`packages/studio/src/providers/auth-provider.tsx`) registers one that
  sets `SESSION_LOST_NOTICE`, drops the session and navigates to `/`, and
  `Login` shows the note.
- **Durations render exactly (#126).** `formatDuration` and
  `formatDurationShort` (`packages/studio/src/lib/format.ts`) replace the
  `Math.round(seconds / 60)` in `Project.tsx`: 30 is "30 seconds" / "30s",
  90 is "1 minute 30 seconds" / "1m 30s", 3600 is "1 hour" / "1h".
  `formatSince` and the queue age in `Queues.tsx` stay coarse on purpose;
  they describe elapsed time, not a setting.
- **The operator password has a floor of 12 characters (#127).**
  `MIN_PASSWORD_LENGTH` (`packages/cli/src/daemon/studio/auth.ts`) is the
  one constant; `setOperatorPassword` refuses anything shorter with a
  `usage` error, and `cmdStudioPasswd` (`packages/cli/src/cli/commands.ts`)
  checks it before the confirm prompt so a too-short password is not typed
  twice. Tests in `packages/cli/test/studio-passwd.test.ts` cover both
  sides.

Tests for the Studio side are `packages/studio/test/errors.test.ts`,
`format.test.ts`, `createProject.test.ts` and the login and 401 cases in
`api.test.ts`.
