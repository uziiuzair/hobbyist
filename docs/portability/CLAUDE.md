# `docs/portability/` eject and the right to leave

**Status:** PROPOSED. Nothing built.

The capability that makes the entire project honest.

## The promise

**You can always leave, in one command, at any time.**

```
hobby eject <name>
```

emits a plain `docker-compose.yml` plus the data directory, stops managing the
instance, and gets out of the way. From that moment Hobbyist is uninstallable
with nothing lost.

## Why this is a capability and not a footnote

This project exists because its author objects to vendor lock-in. A tool built on
that objection which quietly becomes hard to leave would be worse than the
platforms it criticises, because it made the promise out loud.

The guarantee also has to be enforced by design rather than intention, which is
why it constrains other capabilities:

- **The data directory is always a plain, unmodified Postgres data directory.**
  Not a custom format, not a page-versioned blob store, not a proprietary
  manifest. See `docs/decisions/0003`.
- **`pg_dump` always works**, at any moment, without Hobbyist running.
- **Pointing a stock `postgres` binary at the directory always works.**

Any feature that would break one of those three loses to the guarantee. There is
no negotiation on this, and that is deliberate: this is the one place where being
inflexible is the point.

## In scope

- `hobby eject` and the artifacts it emits
- The data-format guarantee, and a test suite that proves it on every commit
  rather than asserting it in a README
- Import: adopting an existing Postgres data directory into Hobbyist management,
  which is eject in reverse and equally important
- Documenting exactly what is lost on eject, honestly. Branch relationships and
  hibernation state do not survive, and saying so plainly is part of keeping the
  promise

## Out of scope

- Migration tooling for other platforms. Getting off Neon or Supabase is
  `pg_dump` and a restore, and pretending otherwise would be inventing a problem.

## Marketing note

`hobby eject` is the best asset this project will ever have, because no
competitor dares ship it. It belongs in the README's first screen, not buried in
a reference page.
