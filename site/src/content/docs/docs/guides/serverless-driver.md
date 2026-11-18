---
title: Neon's serverless driver
description: Point @neondatabase/serverless at a Hobbyist Postgres, over HTTP or WebSockets, on loopback or a public hostname.
sidebar:
  order: 12
---

<p class="state state--starting">new, verified against @neondatabase/serverless 1.2.0</p>

Code written for Neon often uses
[`@neondatabase/serverless`](https://www.npmjs.com/package/@neondatabase/serverless)
instead of a TCP driver, because edge runtimes and Workers have no raw TCP.
Hobbyist's Postgres proxy speaks both of that driver's protocols, on the same
port as Postgres itself (5432 by default):

| Driver API | What it sends | Served as |
|---|---|---|
| `neon()`, `sql.transaction()`, `Pool.query` with `poolQueryViaFetch` | `POST /sql` with JSON | One fresh Postgres connection per request, through the proxy |
| `Pool`, `Client` | The Postgres protocol inside a WebSocket | A Postgres session through the proxy, for as long as the socket is open |

Both are ordinary connections as far as the rest of Hobbyist is concerned. A
sleeping database **wakes** on the first request, exactly as it does for
`psql`. Requests and open WebSockets **count as activity**, so a database an
app is querying does not sleep under it. The database name in the connection
string picks the project, as it does for every other client
([routing](/docs/guides/postgres/#connect)).

The driver's defaults point at Neon's hostnames, so two or three `neonConfig`
settings are always needed. Nothing else in your code changes.

## On your own machine

Plain `http` and `ws` on loopback. Use the connection string `hobby connect`
prints, and set these once, before the first query:

```ts
import { neon, neonConfig, Pool } from '@neondatabase/serverless'

// http://127.0.0.1:5432/sql instead of https://api.<your-host>/sql
neonConfig.fetchEndpoint = (host, port) => `http://${host}:${port || 5432}/sql`
// ws://127.0.0.1:5432/v2
neonConfig.wsProxy = (host, port) => `${host}:${port}/v2`
neonConfig.useSecureWebSocket = false

const sql = neon(process.env.DATABASE_URL!)
const rows = await sql`SELECT ${1}::int AS n`

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const { rows: more } = await pool.query('SELECT now()')
```

The `|| 5432` matters for `Pool.query` with `poolQueryViaFetch`: the driver
builds that request's URL without the port, so `fetchEndpoint` is called with
an empty one. If your proxy is not on 5432, write your port there.

## From an app or worker on the same box

Apps and workers reach their database at `host.docker.internal:<proxyPort>`,
the same address their `DATABASE_URL` already uses. Use the local settings
above, unchanged: traffic from the box's own containers is allowed in
plaintext, as it is for TCP.

The default `fetchEndpoint` would send these requests to
`https://api.docker.internal/sql`, which does not exist, so code that
hardcodes the driver needs the `neonConfig.fetchEndpoint` line above before it
can work here.

:::caution[`proxyHost: "all"` on Linux]
With `proxyHost` set to `"all"`, a container's request reaches the proxy from
the container's own address rather than loopback, and is refused in plaintext
like any other machine's. Leave `proxyHost` at loopback or `"tailnet"` for
containers on the same box, or use TLS as below.
:::

## From anywhere else, with TLS

A request from another machine **must** arrive over TLS. Over TCP, SCRAM keeps
your password off the wire even without TLS; here it does not, because
`/sql` carries the password in a header, and the WebSocket login at the
driver's default (`pipelineConnect: "password"`) sends it in cleartext. So without a certificate, these endpoints answer only loopback and
the box's own containers.

Give the proxy a certificate exactly as for TCP clients, with `proxyTls` and
`proxyHost: "all"`
([reaching a database from another machine](/docs/reference/configuration/#reaching-a-database-from-another-machine)).
The same port then serves `https://` and `wss://` with that certificate:

```ts
// https://db.example.com:5432/sql and wss://db.example.com:5432/v2
neonConfig.fetchEndpoint = (host, port) => `https://${host}:${port || 5432}/sql`
neonConfig.wsProxy = (host, port) => `${host}:${port}/v2`
// useSecureWebSocket stays at its default, true

const sql = neon('postgresql://app:...@db.example.com:5432/blog')
```

A plaintext request from another machine gets a `403` naming what to
configure. `neon()` shows the message. A `Pool` cannot: the WebSocket API
hides the response to a refused upgrade, so the driver reports only that the
connection failed. If a `Pool` fails from another machine and `neon()` works,
check `useSecureWebSocket`.

The certificate is the proxy's own, not Caddy's. Caddy is not involved, and
`caddyEnabled` does not matter here
([ADR 0019](/docs/decisions/0019-the-proxy-terminates-tls/) explains why).

## What is different from Neon

- **No connection pool behind `/sql`.** Each request opens a Postgres
  connection through the proxy and closes it after. That costs one backend
  start and one password exchange per request: a few milliseconds on
  loopback, not measured over a network. A `Pool` over WebSockets keeps its
  sessions open and does not pay this.
- **The hostname is not the route.** Neon picks an endpoint from the host in
  the connection string. Hobbyist picks a project from the database name, as
  for every other client.
- **No JWT.** `authToken` and an `Authorization` header are refused. Put the
  password in the connection string.
- **One statement per query**, as on Neon. `sql` runs each query as a prepared
  statement, and Postgres refuses several statements in one.
- **`neonConfig.pipelineConnect`** works at its default, `"password"`. The proxy
  answers Postgres's SCRAM challenge on the client's behalf, as Neon's proxy
  does. With `pipelineConnect: false` the driver does SCRAM itself, end to end.
- **`forceDisablePgSSL` must stay `true`**, its default. The WebSocket's own
  TLS is the encryption. A Postgres `SSLRequest` inside it is answered `N`.
- **Sizes.** A `/sql` request or response over 10 MiB is refused, as Neon
  refuses one. One WebSocket message over 64 MiB closes the socket.

[Issue #155](https://github.com/uziiuzair/hobbyist/issues/155) is where this
came from.
