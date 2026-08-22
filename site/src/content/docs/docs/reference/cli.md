---
title: CLI reference
description: Every verb the hobby binary accepts, with its flags and what it talks to.
sidebar:
  order: 1
---

<p class="state state--running">checked against the binary in CI</p>

Every verb below appears in `printHelp` (`packages/cli/src/cli/main.ts`). A
script in `site/scripts/check-cli-reference.mjs` runs in CI and fails if this
page lists a verb the binary does not have, or omits one it does.

Two conventions apply throughout:

- **`<target>`** is `project` when the project holds exactly one resource, and
  `project/resource` otherwise.
- **`--json`** is accepted by every command that returns data, and prints the
  same object the human output was rendered from, so the two cannot drift.

## Host and daemon

### `hobby init`

Prepares the host. Creates `~/.hobby`, checks that Docker is reachable, and
inspects the filesystem for reflink support and the host networking Caddy would
need. Warns rather than failing on either.

Accepts `--json`.

### `hobby daemon`

Runs the daemon in the foreground. It owns all state and all lifecycle, listens
on a unix socket for the CLI and MCP, and on loopback TCP for Studio. Only one
may run at a time, and that is enforced rather than assumed.

Takes no flags.

## Projects and resources

### `hobby new <name> [--empty]`

Creates a project, puts a `postgres` resource named `primary` in it, waits for
that database to accept queries, and prints a connection string.

`--empty` creates the project with nothing in it.

### `hobby ls`

Every project, with every resource and its sleep state. A released project is
still listed, marked `(released, not managed)`. An `undeployed` app or worker is
marked `(no code yet)`.

```
blog
  primary  postgres  running  port 15000
  site     app       sleeping  site.blog.example.com
```

Accepts `--json`.

### `hobby create <postgres|app|worker> <name> --project <p>`

Creates a resource row with no code deployed to it, resting in the state
`undeployed`. Deliberately takes no `--port`: a port describes code that does
not exist yet.

Accepts `--json`.

### `hobby pg create --project <p> <name>`

The explicit form, for creating a second database. An alias for
`hobby create postgres`, not a second implementation.

Accepts `--json`.

### `hobby rm <target> [--yes]`

Destroys a resource, or a project, with confirmation. `--yes` skips the prompt.

## Code

### `hobby deploy [path]`

Builds what is in the directory and serves it. The kind is detected from the
contents: a `Dockerfile` means an [app](/docs/guides/apps/), a `wrangler.toml`,
`wrangler.jsonc` or `wrangler.json` means a [worker](/docs/guides/workers/).
Both present is an error rather than a guess.

| Flag | What |
|---|---|
| `--project <p>` | Which project it belongs to |
| `--name <n>` | The resource name |
| `--port <n>` | The port your process listens on inside the container. Apps only |
| `--kind app\|worker` | Only needed when the directory is ambiguous |
| `--json` | Machine-readable output |

## Lifecycle

### `hobby connect <target>`

Opens `psql` against a Postgres resource. The connection string never becomes an
argv element: credentials are passed through the child's environment, so nothing
reading a process list can see the password.

`--json` prints `connectionString` and, when the daemon has a tailnet address,
`tailnetConnectionString`.

If `psql` is not on `PATH`, the connection string is printed instead.

### `hobby sleep <target>`

Stops the resource now, rather than waiting for it to go idle. Accepts `--json`.

### `hobby wake <target>`

Starts it now. Rarely necessary: a resource wakes by itself when something
connects, which is the whole point. `wake` is for when you want it warm before
something else needs it. Accepts `--json`.

### `hobby pin <project>`

Stops this project ever being put to sleep automatically. Useful for the one
thing on the box that has to answer instantly, or anything whose first request
genuinely cannot afford to wait.

Pinning is per project, not per box, so pinning your status page does not keep
nine other projects awake with it. Accepts `--json`.

### `hobby unpin <project> [--sleep-after <seconds>]`

Lets it sleep again. Without the flag it goes back to the box-wide default.

If the box-wide default is itself "never sleep", `unpin` refuses rather than
writing a value that would make it a no-op reporting success, and asks you for
an explicit number.

Accepts `--json`.

:::note
`sleep` and `wake` act on something right now. `pin` and `unpin` change what
the hibernator is allowed to do from now on. Different tense, different verb.
:::

### `hobby logs <target> [--tail N]`

Tails the resource's logs.

## Queues

### `hobby queue ls [project]`

Every queue, with depth and its bound consumer, or a note that it has none.

### `hobby queue create <name> --project <p>`

A queue with no consumer bound yet. Bind one through a worker's own
`wrangler.toml`.

### `hobby queue peek <target> [--limit n]`

The oldest messages, **without leasing them**, so looking does not change what
the consumer will receive.

### `hobby queue send <target> <json>`

Enqueues one message. Works on Linux and macOS, unlike
[producing from inside a container](/docs/guides/queues/#the-linux-producer-gap).

### `hobby queue purge <target> [--yes]`

Deletes every message, with confirmation.

### `hobby queue rm <target> [--yes]`

Destroys the queue, with confirmation.

### `hobby queue set <target> --retention <seconds>`

Changes how long messages are kept. Note that
[retention never sweeps a queue with no drainable consumer](/docs/guides/queues/#retention-has-a-gap-too).

## Connecting from another machine

These are the commands that make the CLI work from your laptop against a box.
See [ADR 0018](/docs/decisions/0018-the-cli-talks-to-a-remote-daemon/) for the
reasoning, and [the remote guide](/docs/guides/remote/) for a walkthrough.

### `hobby login <url>`

Exchanges the operator password for an API token and stores it. Every command
afterwards runs against that box instead of the local socket.

```sh
hobby login https://your-box.tailnet.ts.net
```

The password is read without echoing and never becomes a command-line argument.
`--name` labels the token, so you can tell one machine's from another's when
revoking; it defaults to your hostname.

It refuses to send a token to a plain `http://` origin unless it is loopback. A
token can create and destroy every database on the box, and that is not a thing
to send in cleartext.

### `hobby logout [url]`

Forgets a remote on this machine. The token stays valid on the box until you
revoke it there with `hobby token rm`, and the output says so.

### `hobby remote ls`

Which boxes this machine is logged in to, with the current one marked.

Set `HOBBY_REMOTE=<url>` to aim a single command at a different one without
changing the default.

### `hobby link <project>`

Writes the project name into the `hobby.json` in the current directory, so
commands run from there default to it and stop needing `--project`.

```sh
cd ~/code/blog
hobby link blog
hobby create worker api      # no --project needed
```

An explicit `--project` always wins over the linked one. The project must
already exist: link checks, rather than writing a file that points at nothing.

### `hobby token create <name>`

Issues an API token. **Local only**, over the unix socket, so tokens are minted
by someone with shell access to the box rather than by anyone already holding
one. Shown once and never recoverable: only an argon2id hash is stored.

### `hobby token ls`

Names, creation dates, and the last six characters of each token, which is
enough to match one against a value a machine is holding without the file
containing anything usable.

### `hobby token rm <name>`

Revokes it. Any machine holding it is locked out on its next request.

## Updating

### `hobby update`

Moves the checkout to the newest release tag and rebuilds it by re-running
`install.sh`, which is the same path a fresh install takes.

```sh
hobby update           # update to the newest tag
hobby update --check   # print the newest tag and change nothing
```

It refuses if the checkout has uncommitted changes rather than discarding them.
If the rebuild fails it says the checkout has already moved, because believing
you are still on the old version would be worse than the failure. Restart the
daemon afterwards.

## Studio

### `hobby studio`

Prints the Studio URL and opens it. Prints the public host instead of the
loopback URL when one is configured through Caddy.

### `hobby studio passwd`

Sets the operator password. The prompt never echoes.

## Leaving

### `hobby eject <project> [--release]`

Emits a `docker-compose.yml` plus the data. `--release` also stops Hobbyist
managing the project.

### `hobby adopt <project>`

Manages a released project again.

## Exit codes

| Code | Means |
|---|---|
| `0` | Success |
| `2` | Usage error: an unknown flag, a missing argument |
| non-zero | The operation failed, or the daemon could not be reached |

A daemon that cannot be reached says so and suggests `hobby init` then
`hobby daemon`, rather than failing with a bare status.
