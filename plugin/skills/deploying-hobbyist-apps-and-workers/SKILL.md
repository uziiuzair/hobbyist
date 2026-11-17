---
name: deploying-hobbyist-apps-and-workers
description: Deploy a Dockerfile app or a Cloudflare-style worker (wrangler manifest) to a self-hosted Hobbyist box with `hobby deploy`, then manage its environment variables, logs and queues. Use when the user wants to ship code to their Hobbyist box, bind it to a Postgres database, set secrets on it, read why a deploy or wake failed, or inspect and send to queues.
---

# Deploying apps and workers on Hobbyist

`hobby deploy` builds the directory and serves it. A `Dockerfile` makes it an
app; a `wrangler.toml`, `wrangler.jsonc` or `wrangler.json` makes it a worker.
Both present is an error: pass `--kind app` or `--kind worker`. Apps and
workers sleep and wake like databases, on their first request.

There is no MCP tool for deploy; run the CLI. The env, logs and queue verbs
do have MCP equivalents (`hobby_env_set`, `hobby_logs`, `hobby_queue_peek`,
...).

## Deploy

```sh
hobby deploy . --project blog --name web --port 3000 --database primary
hobby deploy workers/api --project blog                  # a worker; name defaults to the manifest's
hobby deploy . --dockerfile apps/site/Dockerfile --name site --project blog   # monorepo app
hobby deploy workers/api --context . --project blog      # worker installing from a workspace root
```

| Flag | Use |
|---|---|
| `--project <p>` | Target project. Default: the linked project, then the directory name. |
| `--name <n>` | Resource name. |
| `--port <n>` | Port the app listens on inside its container. Apps only. |
| `--database <r>` | Bind a Postgres resource in the same project: `DATABASE_URL` for apps, the `DB` hyperdrive binding for workers. |
| `--env K=V`, `--env-file <f>` | Variables, replacing the current set. |
| `--build-arg K=V` | Docker build argument, kept for redeploys. Apps only. Not for secrets: it is baked into the image. |
| `--dockerfile <f>`, `--context <dir>`, `--kind app\|worker`, `--verbose` | See `hobby deploy --help`. |

Prefer `--database` over copying a connection string into env: hobby injects
it and you never handle the password. A failed build prints its output on
stderr; read it, fix the cause, deploy again. The printed URL is the one that
answers.

## Environment variables and secrets

```sh
hobby env set blog/web MODE=prod
hobby env set blog/web --env-file .env.production   # merged in
hobby env ls blog/web                               # names only, never values
hobby env unset blog/web MODE
```

Values are never printed back by hobby. For a secret, have the user put it in
an env file and pass `--env-file`, rather than typing the value into a
command you run (it would land in the transcript and shell history). A
running resource is stopped so its next request wakes it with the new
values. Postgres resources take no variables.

## Logs

```sh
hobby logs blog/web --tail 200
```

Returns recent output and exits. Use it when a deploy succeeded but requests
fail, or when `hobby ls` shows "wake refused". Then `hobby wake blog/web`
retries at once instead of waiting for the daemon's backoff.

## Queues

```sh
hobby queue ls blog                          # depth, consumer, retention
hobby queue create jobs --project blog       # bind a consumer in the worker's wrangler config
hobby queue peek blog/jobs --limit 10        # look without leasing
hobby queue send blog/jobs '{"id":1}'        # enqueue one JSON message
hobby queue set blog/jobs --retention 86400  # 60 to 1209600 seconds
hobby cron ls blog                           # worker cron triggers, read-only
```

## Destructive verbs

Ask the user before any of these, and name the exact target:

- `hobby queue purge <target>` deletes every message.
- `hobby queue rm <target>` destroys the queue.
- `hobby rm <project>/<resource>` destroys an app or worker and its images;
  `hobby rm <project>` destroys the whole project.
- `hobby sleep <target> --force` interrupts in-flight work.

Each prompts for confirmation; a non-interactive shell aborts with exit 1.
`--yes` skips the prompt only after the user has confirmed in this
conversation. The MCP tools take `confirm: true` under the same rule.
