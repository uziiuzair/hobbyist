# `docs/hibernation/` idle detection and sleep

**Status:** PROPOSED. Nothing built.

The sleep half of the pair the proxy completes. Watches instances, notices when
nothing has been connected for a while, and stops them.

## Why bother, given nobody is billed

Scale-to-zero on a managed platform exists to reduce a bill. Here there is no
bill, so the reason is different and still good: on a single small box, the
difference between five sleeping Postgres instances and five running ones is the
difference between a machine that works and one that swaps itself to death.

**We want the behavior, not the meter.** There is no usage accounting, no CU-hour
equivalent, and no billing subsystem. See `docs/decisions/0004`.

## In scope

- Activity tracking per instance, **read from the proxy**, which is on the path
  for every connection and therefore already knows the live connection count for
  free. `pg_stat_activity` is consulted once immediately before stopping, purely
  as a guard against someone who connected directly to the container, and to
  refuse sleeping mid-transaction
- The idle threshold, its default, and how a user overrides it per instance
- Graceful stop: refusing to sleep mid-transaction, draining cleanly
- Never sleeping instances that are pinned awake
- Interaction with backups, since a backup job must not be interrupted by a sleep
  and must not itself count as activity that prevents sleeping forever

## Out of scope

- Waking anything. The proxy wakes. This component only ever sleeps things.
- Container mechanics, which is `engine/`

## Reference point

Xata's CNPG scale-to-zero sidecar polls cluster activity every minute and runs in
under 15MiB of memory and 0.05 CPU. That is the cost envelope to stay inside. A
watcher that is itself a meaningful load has defeated its own purpose.

## Decisions made

- **Event-driven, sourced from the proxy.** No polling loop asking Postgres
  whether anyone is around. The proxy knows, because it is the thing they connect
  through. Zero cost, exact, and it removes the poll-interval tuning problem.
- **The pooler question is mostly dissolved.** Sleep triggers on zero live
  proxied connections for T seconds, so a pooler holding an idle connection
  correctly keeps the instance awake while it holds it, and stops mattering the
  moment it disconnects. What remains is deciding whether an *idle* proxied
  connection should eventually be evicted, which is a different and smaller
  question.

## Open questions

- Should a long-idle proxied connection be closed so the instance can sleep? A
  developer who left `psql` open on Friday should not keep a database awake all
  weekend, but killing connections is rude and surprising.
- What is the default idle threshold, and is it the same for a database someone
  is actively developing against as for one serving a deployed app?
