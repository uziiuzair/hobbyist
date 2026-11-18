---
name: branching-hobbyist-postgres-for-agents
description: Use copy-on-write branches of a Hobbyist Postgres project to test a risky migration, schema change or data fix against a copy of real data before touching the original. Use when about to run a migration, ALTER, backfill or destructive SQL on a Hobbyist database, or when the user asks for a branch, a schema diff, a reset of a branch, or a throwaway copy that cleans itself up.
---

# Branching Hobbyist Postgres for agents

A branch is a new project made from a copy of another project's Postgres
data. On a reflink filesystem (XFS, ZFS, APFS) the copy is instant; on ext4
it is a real copy and the command says so. The branch has its own container,
port and connection string and starts asleep. Changing it never touches the
parent.

The MCP tools `hobby_branch`, `hobby_diff`, `hobby_reset` and `hobby_expire`
mirror the commands below.

## The loop: branch, migrate, diff, decide

1. **Branch before anything risky.** Give it an expiry so a forgotten branch
   cleans itself up:

   ```sh
   hobby branch blog blog-migrate-users --expires 1d
   ```

   A pinned parent that is awake is refused unless you add `--allow-pause`,
   which pauses it for the length of the copy. Ask the user before passing it.
   A project holding apps, workers or queues cannot be branched yet.

2. **Point the migration at the branch**, never at the parent. Get the
   branch's connection string into the environment without printing it:

   ```sh
   DATABASE_URL="$(hobby connect blog-migrate-users --json | jq -r .connectionString)" npm run migrate
   ```

3. **Check what changed in the schema:**

   ```sh
   hobby diff blog-migrate-users          # branch against its parent
   hobby diff blog blog-migrate-users     # any two projects; lines only in the second are +
   ```

   It wakes what it compares and exits 0 whether or not anything differs.
   Read the diff; `--json` gives each resource's hunks as data.

4. **Decide with the user.** If the result is right, run the same migration
   against the parent (the user's call, not yours). If it is wrong, reset the
   branch and try again, or discard it.

## Start over on the same branch

```sh
hobby reset blog-migrate-users
```

Replaces the branch's data with a fresh copy of the parent's current data.
Everything written to the branch is lost. It asks the user to type the
branch name; in a non-interactive shell that aborts with exit 1. Pass
`--yes` only when the user has agreed to throw away the branch's changes.
The branch keeps its name and port, and its database user and password
become the parent's, which a branch already shares unless someone changed
one of them. A branch with an open
session is refused rather than cut off. The MCP `hobby_reset` needs
`confirm: true`.

## Expiry

```sh
hobby expire blog-migrate-users 7d      # counted from now: 7d, 36h, 1d12h, 90m
hobby expire blog-migrate-users --never # keep it
```

The daemon deletes an expired branch on its next sweep, but only while the
branch is asleep and unpinned; otherwise it waits. Branches never expire
unless asked.

## Discard

```sh
hobby rm blog-migrate-users
```

Destroys the branch, with the same typed confirmation as `reset`. Check the
name twice: `hobby rm blog` would destroy the parent. `--yes` only after the
user confirms the exact name. `hobby ls` marks branches as
`(branch of blog)`, which is how to tell them apart.

## Rules

- Never run an untested destructive migration on a parent when a branch is
  one command away.
- Never print a branch's connection string; it has the parent's password.
- `hobby reset` and `hobby rm` are irreversible. Snapshots
  (`hobby snapshot`) are the way to keep a copy you can go back to.
