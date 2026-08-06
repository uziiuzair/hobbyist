# `docs/` the organized half

Hobbyist keeps its written knowledge in two places, and the split is not
arbitrary.

**`claude_docs/` is the workshop.** It holds working memory that belongs to the
project as a whole: what is happening right now, what shipped last month,
strategy still being argued about, scars paid for in debugging time, notes to
self. It is allowed to be messy in the way a workshop is messy, because that is
where the work happens, and because most of it is only meaningful in the context
of the moment it was written.

**`docs/` is the filed half.** Everything here has a *home*: a named folder, with
a stated purpose, that someone can navigate to without knowing the conversation
that produced the document. Research absolutely lives here, as long as it is
filed. The organizing principle is not "finished versus unfinished." It is
**filed versus unfiled.**

Both are load-bearing. Neither is better. But they have different admission
criteria, and mixing them is how a `docs/` folder rots into a junk drawer.

---

## The line

Before adding anything, ask:

> **Does this belong to a named capability that already has or deserves a folder?**

**Yes → `docs/<that folder>/`.** File it. A half-formed comparison of wire-protocol
proxy implementations belongs in `docs/proxy/research/`. A benchmark of reflink
clone times on XFS versus ZFS belongs in `docs/branching/research/`. Being
incomplete is fine. Being unfiled is not.

**No → `claude_docs/`.** It is repo-wide state, running history, cross-cutting
strategy, or a thought that has not yet attached to anything. `ACTIVE_CONTEXT.md`
holds current state, `PROGRESS.md` holds history, `INDEX.md` maps the rest.

The two failure modes this prevents:

- **A loose file lands at `docs/` root**, or in a folder it does not belong to, and
  the shelf stops being navigable.
- **A finished decision stays in `claude_docs/`**, and nobody finds it, because
  they were looking on the shelf.

When genuinely unsure, write it in `claude_docs/` first. Filing it later is
cheap. Un-shipping something that was never ready is not.

---

## What lives here

### Root: this file, and no more

`docs/CLAUDE.md` is the only file at `docs/` root. If a new document does not fit
an existing folder, that is a signal to create a folder or to send it to
`claude_docs/`, never to drop it here.

### Capability folders: one per thing we are building

Each holds everything about one capability, split the same way:

```
docs/<capability>/
  CLAUDE.md     scope guard: what this capability is, what does NOT belong
  research/     why, evidence, prior art, benchmarks, open questions
  specs/        what we are building, actionable without reading the conversation
```

| Folder | The capability | Order |
|---|---|---|
| [`cli/`](cli/) | The `hobby` binary. Command surface, config resolution, the daemon, output conventions. | 1 |
| [`engine/`](engine/) | Postgres instance lifecycle. Create, start, stop, destroy, data directories, container runtime. | 1 |
| [`proxy/`](proxy/) | **The keystone.** Wake-on-connect Postgres wire-protocol proxy and connection pooling. | 2 |
| [`hibernation/`](hibernation/) | Idle detection and suspend. The sleep half of the pair the proxy completes. | 3 |
| [`branching/`](branching/) | Copy-on-write branching via PostgreSQL 18 clone. Filesystem detection and fallbacks. | 4 |
| [`mcp/`](mcp/) | The MCP server exposing the CLI verbs to agents. | 5 |
| [`backups/`](backups/) | Backup, restore and point-in-time recovery, wrapping existing tools. | 6 |
| [`portability/`](portability/) | `hobby eject` and the data-format guarantees that make leaving possible. | 6 |

The order column is the intended build sequence, not a priority ranking. The
proxy is second on purpose: it is the component most likely to prove the whole
idea unworkable, so it gets tested early rather than late.

`research/` accepts incomplete and even wrong, as long as it is dated. `specs/`
must be actionable by an engineer who did not read the conversation. When a
`research/` doc reaches a conclusion, do not move it. Write the conclusion into
`specs/` and link back. The trail of reasoning is worth keeping.

**Each capability folder carries its own `CLAUDE.md`** stating what it is for and
what must not be filed there. A folder that accepts "anything vaguely related"
becomes a second junk drawer inside the organized half.

### Cross-cutting reference: organized by kind, not by capability

| Folder | What it is | Reach for it when |
|---|---|---|
| [`decisions/`](decisions/) | Numbered, dated architecture decision records. Immutable. Disproportionately about what we chose **not** to build, because scope is this project's main risk. | Wondering why something is absent, or about to add something large. |

A new cross-cutting folder needs a new *kind* of document, not a new topic.

Some folders may carry their own `README.md` index. **Nested guidance is narrower
and wins inside its folder.** This file governs the space between them.

---

## Adding something

1. **Apply the line above.** Named capability with a folder means file it here.
   Repo-wide state or an unattached thought means `claude_docs/`. That is a
   routing decision, not a quality judgment.
2. **Find the folder, or make the case for a new one.** A new capability folder
   means new scope, and new scope in this project needs an ADR in `decisions/`
   first. Check the out-of-scope list in the root `CLAUDE.md` before proposing one.
3. **Never add a loose file at `docs/` root.**
4. **Update the indexes in the same change:** this file's table if you added a
   folder, and `claude_docs/INDEX.md`, which is the repo-wide map. A stale map is
   how sprawl restarts.
5. **Rewire pointers when you move or retire something.** A moved doc whose old
   path is still referenced is worse than a missing one, because the reader
   concludes it was deleted. Grep the whole repo for the old path before
   committing. Dated history entries in `claude_docs/ACTIVE_CONTEXT.md` and
   `PROGRESS.md` are the exception, being append-only, so leave them alone.

## Conventions

- **Name files `YYYY-MM-DD-topic.md` inside capability folders.** Dates make
  research legible six months later and make staleness visible without opening
  the file. Decision records use `NNNN-slug.md` instead, because their number is
  their identity.
- **State status at the top** of capability docs: `PROPOSED`, `RATIFIED`,
  `SUPERSEDED BY <file>`, or `NOTES` for raw dumps. A reader must never have to
  guess whether a doc is a decision or a musing.
- **Dated artifacts are immutable.** Anything under `decisions/`, and anything
  named `YYYY-MM-DD-*`, records a moment. Do not rewrite a shipped spec to match
  what was later built. Write a new one and supersede the old.
- **Retire, do not twin.** Superseding means marking the old doc `SUPERSEDED BY`
  and moving its pointers in the same change. No `_v2`, no `_OLD`, no two docs
  disagreeing about one fact.
- **One source of truth per fact-type.** If two docs describe the same thing, one
  is wrong and should be deleted rather than maintained in parallel.
- **Ground claims in code.** Cite `path/to/file.ts` with a symbol name rather than
  describing what you believe the code does. Docs that document intentions instead
  of implementations are how a repo starts lying to itself.
- **Benchmarks carry their hardware.** A clone timing without the filesystem, disk
  type and dataset size is not a benchmark, it is a rumour.
- **Mark what is not real yet.** Use `DRAFT pending <issue>` for sections whose
  dependency has not shipped. A reader must never execute an aspiration against a
  real database.
- **No em-dashes.** Anywhere. Commas, colons, parentheses, or restructure.
- **Scripts and binaries never live beside docs.** Executables go to `scripts/` or
  `tools/`. A folder that accepts one `.sh` ends up accepting all of them.

## What never goes here

Repo-wide status, session handoffs, work summaries, roadmaps, running history,
anything named `*_HANDOFF.md`, `*_SUMMARY.md`, `*_STATUS.md`, or `TO_DEPLOY.md`.

Not because they do not matter. Several matter more than half of what is on this
shelf. They belong in `claude_docs/`: current state in `ACTIVE_CONTEXT.md`,
history in `PROGRESS.md`, the map in `INDEX.md`.

**Unfiled thinking goes to `claude_docs/`. Everything here is filed.** That is
the whole arrangement, and it only works if both halves are held.
