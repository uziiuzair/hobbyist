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
| Loopback TCP, `apiPort`, default 7432 | **None.** Local shell access is the root of trust |
| The unix socket, `~/.hobby/hobby.sock` | Filesystem permissions |
| The Studio listener, default 8443 | The operator session cookie |

Through the Studio listener, only `/studio/login`, `/studio/logout`,
`/studio/session` and `/v1/health` answer unauthenticated.
[ADR 0008](/docs/decisions/0008-studio-is-network-exposed/).

## Routes

| | |
|---|---|
| `GET /v1/health` | Liveness |
| `GET /v1/preflight` | What `hobby init` reports: Docker, filesystem, host networking |
| `GET` `POST /v1/projects` | List, create |
| `GET` `DELETE /v1/projects/{name}` | Detail with resources, destroy |
| `POST /v1/projects/{name}/resources` | Create a resource. Body `{ kind, name }` |
| `POST /v1/projects/{name}/eject` | Render the compose file |
| `POST /v1/projects/{name}/adopt` | Manage a released project again |
| `POST /v1/projects/{name}/sleep-policy` | Body `{ sleepAfterSeconds }`. `null` pins the project awake, a positive integer is its own idle threshold |
| `GET` `DELETE /v1/resources/{id}` | Detail, destroy |
| `POST /v1/resources/{id}/start` | Wake |
| `POST /v1/resources/{id}/stop` | Sleep |
| `GET /v1/resources/{id}/connection` | The connection string, and the tailnet one |
| `GET /v1/resources/{id}/logs` | Logs |
| `POST /v1/resources/{id}/query` | Run SQL. Body `{ sql, params? }` |
| `POST /v1/resources/{id}/deploy` | Deploy code to an existing resource |
| `POST /v1/resources/{id}/queue/messages` | Enqueue. Body `{ body, delaySeconds? }` |
| `POST /v1/resources/{id}/queue/retention` | Body `{ retentionSeconds }` |

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
