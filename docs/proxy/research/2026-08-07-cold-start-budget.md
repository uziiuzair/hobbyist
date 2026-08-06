# The cold start budget

Status: NOTES. The target is set. **The measurements do not exist yet.**
Date:   2026-08-07

`docs/proxy/CLAUDE.md` says to set a target before building, measure honestly,
and publish it. This file is the first half. M0 is the second.

## The target

**Under 1 second, measured from TCP accept to first query answered, on a
database that was asleep. 3 seconds is a hard ceiling and crossing it blocks
release.**

Three seconds is not arbitrary. It is roughly where common ORM and pool connect
timeouts begin firing, and `docs/proxy/CLAUDE.md` names client connect timeouts
as the most likely source of "it does not work" reports. Above that number the
wedge does not read as slow, it reads as broken, and a broken first connection is
worse for the project than no hibernation at all.

## What the number is composed of

Measure each separately, because knowing the total is useless for fixing it:

| Segment | What happens |
|---|---|
| Accept and parse | TCP accept, TLS handshake, startup packet read, project resolved |
| Wake decision | Daemon lookup, state transition, container start issued |
| Container start | Runtime starts an already-created, stopped container |
| Postgres ready | Startup through to accepting connections |
| Readiness detect | How long after Postgres is ready we notice |
| Connect and splice | Dial upstream, replay startup packet, splice |

## The levers, in the order they should be tried

1. **Keep containers stopped, not removed.** Recreating on wake spends time we do
   not have. Settled in `docs/engine/CLAUDE.md`, and this measures what it saved.
2. **Clean, fast shutdown.** An instance stopped mid-checkpoint does recovery on
   the way back up, and that recovery lands entirely inside the user's first
   query.
3. **Readiness polling at tens of milliseconds, not one second.** A one second
   poll interval alone can consume the entire budget while Postgres sits ready
   and idle. This is the single most likely source of a needlessly bad number.
4. **A small warm pool**, only if 1 through 3 miss. It permanently spends some of
   the RAM that hibernation exists to reclaim, so it is an escalation and not a
   default.

## What M0 has to produce

A throwaway spike, not a foundation. It should be deleted afterwards.

- Per-segment timings on **a five dollar VPS and a Mac Mini**, with filesystem,
  disk type and Postgres version stated, per the rule that a benchmark without
  hardware is a rumour.
- The same run on **Bun and on Node**, because ADR 0006 accepted that Bun's
  socket stack is younger than Node's and that the proxy is the keystone. If Bun
  disappoints here, the runtime flips and we lose only the compile step.
- Behaviour at a **cold page cache**, since a benchmark run in a loop measures a
  warm box and nobody's first query of the day is warm.
- A **failure timing**: how long a wake that never succeeds takes to give up, and
  whether the client gets a real `ErrorResponse` rather than a dropped socket.

## The decision this gates

If the naive path cannot beat 3 seconds on a five dollar VPS after levers 1
through 3, the project changes shape: either a warm pool becomes mandatory and
the RAM story gets rewritten, or the wedge has to be re-examined. Learning that
in week one is the entire reason M0 comes before M1.
