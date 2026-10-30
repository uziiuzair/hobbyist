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
  primary  postgres  running  connect: hobby connect blog/primary
```

It says `running` because `hobby connect` just woke it. Had you run `hobby ls`
straight after `hobby new`, it would have said `sleeping`: a new database is
booted once so it is initialised and then stopped cleanly, on purpose, so that
its first real start is not a crash recovery (`createPostgres`,
`packages/pg/src/postgres.ts`). Asleep is the resting state of everything here.

The line says how to reach it rather than naming a port. The port you dial is
the proxy's, 5432, which is in the connection string and is what makes wake
work. The container also has a host port of its own (`hobby ls --json` shows
it as `config.hostPort`), but connecting there goes around the wake router:
it fails while the database sleeps, and an idle session on it is ended by
hibernation.

The port on that line is the resource's own host port, allocated from the
15432 to 25432 range postgres uses (apps and workers have ranges of their own)
for a direct connection to the container. It is not the port you normally dial:
that is the proxy on 5432, which is what makes wake work.

Leave it alone for five minutes and look again. The state becomes `sleeping`.
The container is stopped, not removed (`docker stop`, through
`ComputeRuntime.stop` in `packages/core/src/docker.ts`), so its data directory,
network and name are all still there and the next wake is a `docker start`.
That default lives in `sleepAfterSeconds` and is configurable; see
[configuration](/docs/reference/configuration/). Note that the value is copied
into a project when it is created, so changing it later only affects new
projects; `hobby unpin blog --sleep-after 900` changes this one.

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
no error.

The one exception is a wake that fails, say because Docker is down or the
container will not boot. Then the proxy answers the connection with an error
rather than hanging, and the daemon refuses further automatic wakes for a
growing interval (30 seconds, doubling, capped at 15 minutes) so a broken
database does not crash-loop. `hobby ls` shows the refusal and when the next
try is; `hobby wake blog` retries at once. See
[the CLI reference](/docs/reference/cli/#hobby-ls).

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
