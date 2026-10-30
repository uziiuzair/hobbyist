---
title: Daemon HTTP API
description: The only control surface. CLI, Studio and MCP are three clients of it.
sidebar:
  order: 3
---

<p class="state state--running">works</p>

**The daemon API is the only control surface.** CLI, Studio and MCP are three
clients of this one API, and none of them touches Postgres or Docker directly.
That turns "the CLI and MCP must never diverge" from a discipline problem into a
structural one.

The full specification is
[`docs/api/openapi.yaml`](https://github.com/uziiuzair/hobbyist/blob/main/docs/api/openapi.yaml),
OpenAPI 3.1. It is derived from `packages/cli/src/daemon/routes.ts` and
`packages/cli/src/daemon/wire.ts`, and it is documentation rather than a schema
the daemon enforces.

## Listeners, and what authenticates

| Listener | Auth |
|---|---|
| The unix socket, `~/.hobby/hobby.sock` | **None.** Filesystem permissions are the whole story. This is the CLI's and MCP's transport |
| Loopback TCP, `apiPort`, default 7432 | **Gated.** Every `/v1` route needs the operator session cookie or an API token as `Authorization: Bearer <token>` |
| Studio | Served on that same loopback listener, behind the same gate |

The gate is `isAuthenticated` in `packages/cli/src/daemon/studio/routes.ts`:
one function for two credentials. A browser presents the `hobby_studio_session`
cookie set by `POST /studio/login`; the CLI on another machine presents a
bearer token from `hobby login` (which calls `POST /studio/token`) or from
`hobby token create` on the box. A request that fails gets
`401 { "error": { "code": "unauthorized", "message": "authentication required" } }`,
which is what `curl http://127.0.0.1:7432/v1/projects` returns on a fresh
install. Only `/studio/login`, `/studio/logout`, `/studio/session`,
`/studio/token` and `/v1/health` answer unauthenticated there
(`UNAUTHENTICATED_PATHS`).
[ADR 0008](/docs/decisions/0008-studio-is-network-exposed/),
[ADR 0018](/docs/decisions/0018-the-cli-talks-to-a-remote-daemon/).

Tokens are never listed or revoked over HTTP: `hobby token ls` and
`hobby token rm` read and write files under `~/.hobby` on the box, so a leaked
token cannot enumerate or mint others, and `POST /studio/token` itself cannot
be called with a token, only with the password.

## Routes

| | |
|---|---|
| `GET /v1/health` | Liveness. The one `/v1` route open without a credential |
| `GET /v1/version` | `{ version }`, the daemon's build. Behind the gate on purpose, unlike health |
| `GET /v1/preflight` | What `hobby init` reports: Docker, filesystem, host networking |
| `GET` `POST /v1/projects` | List, create. Create accepts `{ name, sleepAfterSeconds? }`; absent, the box-wide default is copied in |
| `GET` `DELETE /v1/projects/{name}` | Detail with resources, destroy |
| `POST /v1/projects/{name}/resources` | Create a resource. Body `{ kind, name, ... }`, kind-specific; `queue` needs only a name |
| `POST /v1/projects/{name}/branch` | A new project from a clone of this one's data. Body `{ name, allowPause? }`, 201 with `{ project, resources, clone, paused, pausedMs, resumeFailures }` |
| `GET /v1/projects/{name}/crons` | `{ crons: [{ worker, resourceId, cron, nextAt, lastAt, lastOutcome }] }`, read-only |
| `GET /v1/projects/{name}/queues` | `{ queues: [{ resource, depth, oldestMessageAgeSeconds, consumer }] }` |
| `GET` `POST /v1/projects/{name}/snapshots` | List, newest first (answers for a deleted project), and take one. Body `{ allowPause?, online? }` |
| `POST /v1/projects/{name}/eject` | Render the compose file. `?release=true` also hands the project over |
| `POST /v1/projects/{name}/adopt` | Manage a released project again |
| `POST /v1/projects/{name}/sleep-policy` | Body `{ sleepAfterSeconds }`. `null` pins the project awake, a positive integer is its own idle threshold |
| `POST /v1/snapshots/{id}/restore` | Body `{ as?, inPlace?, allowPause? }`. 201 into a new project, 200 in place |
| `DELETE /v1/snapshots/{id}` | `{ deleted: true }` |
| `GET` `DELETE /v1/resources/{id}` | Detail, destroy |
| `POST /v1/resources/{id}/start` | Wake |
| `POST /v1/resources/{id}/stop` | Sleep |
| `GET /v1/resources/{id}/connection` | The connection string, and the tailnet one |
| `GET /v1/resources/{id}/logs` | Logs |
| `POST /v1/resources/{id}/query` | Run SQL. Body `{ sql, params? }` |
| `POST /v1/resources/{id}/deploy` | Deploy code to an existing resource |
| `POST /v1/resources/{id}/env` | Body `{ set?, unset?, replace? }`. Returns `{ resource, keys, stopped }`, names only |
| `GET /v1/resources/{id}/queue/messages` | Peek without leasing. `?limit=` defaults to 10. `{ messages: [{ id, timestampMs, attempts, contentType, body }] }` |
| `POST /v1/resources/{id}/queue/messages` | Enqueue. Body `{ body, delaySeconds? }`, 201 with `{ id }` |
| `DELETE /v1/resources/{id}/queue/messages` | Purge. `{ purged }` |
| `POST /v1/resources/{id}/queue/retention` | Body `{ retentionSeconds }`, 60 to 1209600 |
| `POST /studio/login` | Body `{ password }`. Sets the session cookie |
| `POST /studio/logout` | Clears it |
| `GET /studio/session` | `{ authenticated }`, open by design |
| `POST /studio/token` | Body `{ password, name }`. `{ token, name }`, shown once. Cannot be called with a token |

The API says `start` and `stop`, because those are mechanical container
operations. The CLI says `wake` and `sleep`, because that is the domain. One
function does the translation.

`POST /v1/projects/{name}/resources` and `POST /v1/resources/{id}/deploy` are
two acts on purpose: a resource can exist as a row with an id and a hostname and
no code, in the resting state `undeployed`.
[ADR 0014](/docs/decisions/0014-resource-records-exist-before-code/).

## Errors

One envelope, always:

```json
{ "error": { "code": "resource_not_found", "message": "...", "hint": "..." } }
```

| Code | Status |
|---|---|
| `project_not_found`, `resource_not_found` | 404 |
| `name_taken`, `conflict` | 409 |
| `invalid_name`, `usage` | 400 |
| `unauthorized` | 401 |
| `build_failed` | 422 |
| `runtime_unavailable` | 503 |
| `wake_timeout` | 504 |
| `ambiguous_target`, `wake_failed`, `not_ready`, `unknown_kind`, `internal` | 500 |

## Secrets never cross this boundary

In resource payloads, a postgres `config.password` is omitted entirely, and app
`env` and worker `vars` values read as `<redacted>`.

There are exactly two deliberate exceptions, and both are the point of the call:
`GET /v1/resources/{id}/connection`, and the compose file eject renders, because
a compose file that cannot start Postgres would break the leaving promise.

Request bodies are JSON, capped at 64KB.

## Not on this API

The [wake router ports](/docs/concepts/sleep-and-wake/) speak Postgres wire
protocol on 5432 and plain HTTP on 7433. They are not part of this API and never
answer it.
