# ACTIVE CONTEXT

What is true right now. Overwrite freely, this file is not history.

## State: pre-code

The repository contains documentation and no implementation. Nothing has been
built, no runtime has been chosen, and no dependency has been added.

## What exists

- Root `CLAUDE.md` with standing project context, assets, scope and constraints
- `docs/` structure with eight capability folders and five decision records
- `claude_docs/` with this file, `PROGRESS.md` and `INDEX.md`
- `README.md`, currently empty

## Assets

| Asset | Value |
|---|---|
| Domain | `hobbyist.sh` |
| NPM namespace | `@hobby.sh/*` (scope unclaimed at the registry as of 2026-08-06) |
| Repository | `github.com/uziiuzair/hobbyist` |
| CLI binary | `hobby` |

## The next decision, before any code

**Language and runtime for the CLI and daemon.** Everything else waits on it.

- Node keeps everything inside the `@hobby.sh` namespace and makes the MCP server
  nearly free, at the cost of requiring a runtime on the target box.
- Go or Rust give a single static binary with no runtime dependency, which is
  worth a lot for a tool people install on a bare VPS, at the cost of a second
  language for the MCP surface.

Decide, then write it up as ADR 0006.

## The next build step after that

1. `hobby pg create` producing a running Postgres and a connection string
2. **The wake-on-connect proxy**, immediately after, before anything else

The proxy is second deliberately. It is the component most likely to prove the
whole idea unworkable, so it gets tested in week two rather than month six. See
`docs/proxy/CLAUDE.md`.

## Open risks

- **The ext4 problem.** Instant branching needs reflinks, which means XFS with
  reflinks, ZFS or APFS. ext4 is the default on many cheap VPS images and has no
  reflink support. This is the constraint most likely to generate confused issue
  reports.
- **Cold start latency is unmeasured.** It is the number the project will be
  judged on, and there is currently no target and no data.
- **Client connect timeouts.** Some ORMs and pool managers default to timeouts
  shorter than a container start. This is the most likely source of "it does not
  work" reports and needs testing against real client libraries early.
- **Branching a live database** requires quiescing the source, which is the main
  unsolved implementation problem.

## Prior art not yet read

Xata's open-source core (Apache 2.0) is the closest existing work by a wide
margin, and none of it has been read yet. Do that before writing the proxy.

---

Last Updated: 2026-08-06
