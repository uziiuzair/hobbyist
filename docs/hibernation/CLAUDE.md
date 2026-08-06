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

- Activity tracking per instance, most likely from `pg_stat_activity`
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

## Open questions

- Poll or event-driven. Polling is simpler and a minute of granularity seems
  plenty, given nothing is being billed by the second.
- Does a long-running idle connection from a pooler count as activity? Almost
  certainly not, and getting this wrong means nothing ever sleeps. This is the
  single most likely bug in the component.
