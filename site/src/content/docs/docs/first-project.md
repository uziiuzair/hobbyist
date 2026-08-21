---
title: Your first project
description: From nothing to a connection string, and then watching it sleep and wake.
---

<p class="state state--running">works</p>

This assumes [the installer](/docs/install/) has run.

## Start the daemon

```sh
hobby daemon
```

The daemon owns all state and all lifecycle. Nothing else in the system starts
or stops a container. It listens on a unix socket for the CLI and MCP, and on
loopback TCP for Studio, and it stays in the foreground, so give it its own
terminal or put it behind your init system.

## Make something

```sh
hobby new blog
```

That creates a project called `blog`, puts a `postgres` resource named `primary`
inside it, waits for the database to accept queries, and prints a connection
string. The whole thing is one command because that is the ergonomic being
copied: a managed platform does not ask you to pick a compute size before you
have a table.

If you want the namespace without the database:

```sh
hobby new blog --empty
```

## Connect

```sh
hobby connect blog
```

This opens `psql` against the resource. The connection string never appears in
the argument list of the child process: the credentials are passed through the
environment instead, so nothing that reads a process list can see your password.
Your own `PSQLRC`, `PAGER` and `PGSSLMODE` still apply.

To get the string itself, for an ORM or a `.env`:

```sh
hobby connect blog --json
```

That also returns a `tailnetConnectionString` when the daemon has a tailnet
address, which is the one to use from another machine.

## Watch it sleep

```sh
hobby ls
```

```
blog
  primary  postgres  running  port 15000
```

The port on that line is the resource's own host port, allocated from the
15000 to 19999 range for a direct connection to the container. It is not the
port you normally dial: that is the proxy on 5432, which is what makes wake
work.

Leave it alone for five minutes and look again. The state becomes `sleeping` and
the container is gone. That default lives in `sleepAfterSeconds` and is
configurable; see [configuration](/docs/reference/configuration/).

You can also do it now, rather than waiting:

```sh
hobby sleep blog
hobby ls
```

## Watch it wake

```sh
hobby connect blog
```

There is no `hobby wake` in that sequence, and that is the entire point. The
proxy accepted your connection, noticed the resource was asleep, asked the
daemon to start it, waited for Postgres to actually accept queries, and only
then completed the handshake. Your client saw one slightly slow connection and
never saw an error.

`hobby wake blog` exists for when you want it warm before something else needs
it, not because anything requires you to call it.

## Look at it

```sh
hobby studio passwd     # set the operator password, once
hobby studio            # print the URL
```

Studio browses tables, runs SQL and reads schema. It is exposed on the network
by design, which makes its single operator credential a security boundary rather
than a formality. It is also the youngest surface in the project. Put it behind
Tailscale or a Cloudflare Tunnel rather than on the open internet. See
[Studio](/docs/guides/studio/).

## Leave

The point of the exercise:

```sh
hobby eject blog
```

You get a `docker-compose.yml` and the data directory. Run
`docker compose up` on any machine with Docker and you have your database back,
with no Hobbyist installed anywhere. Add `--release` and Hobbyist also stops
managing it; `hobby adopt blog` takes it back.

## Next

- [Sleep and wake](/docs/concepts/sleep-and-wake/), what actually happened above.
- [Projects and resources](/docs/concepts/projects-and-resources/), the model.
- [Apps](/docs/guides/apps/) and [Workers](/docs/guides/workers/), the other
  things a project can hold.
