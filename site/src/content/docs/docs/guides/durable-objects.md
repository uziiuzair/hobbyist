---
title: Durable Objects
description: Objects whose state survives a sleep, and alarms that fire for a container that is not running.
sidebar:
  order: 4
---

<p class="state state--starting">works, rough edges</p>

Durable Objects are a capability of a [worker](/docs/guides/workers/), not a
resource kind of their own. They work the way you would expect, with one
genuinely hard problem solved: **an alarm fires even when the container holding
the object is stopped.**

## Why that is hard

A Durable Object alarm is a timer inside the runtime. A stopped container has no
runtime, so it has no timer, and an alarm armed before a sleep would simply
never fire. On a platform where everything sleeps by default, that would make
alarms unusable, which is to say it would make Durable Objects unusable for the
thing they are most often reached for.

## How it is solved

The schedule is held outside the runtime.

1. Alarm deadlines are read out of each object's own sqlite file, which is
   readable while the container is stopped. The deadline is `_cf_METADATA` key 1,
   an int64 of nanoseconds since the epoch.
2. The daemon keeps a mirror of those deadlines and ticks over it.
3. When a deadline arrives for a sleeping worker, the daemon wakes it, and the
   runtime fires the alarm normally on the way up.
4. A worker with an alarm about to fire refuses to sleep in the first place,
   through `ResourceKindHandler.guard`.

[ADR 0012](/docs/decisions/0012-durable-objects-and-the-alarm-mirror/).

## Verified, not asserted

An alarm armed 60 seconds out fired 61 seconds after the container was stopped,
with no request in between. Verified against real Docker on 2026-08-11. Object
state across a sleep was verified the same way: `GET /count` returned 1, then 2,
then 3, with a full stop and start between the second and third.

## The caveat

**An alarm can be up to one mirror tick late, plus a cold start.** The tick is
10 seconds. If your alarm needs to fire within a second of its deadline, this is
not that.

## Storage layout

```
~/.hobby/projects/<project>/<worker>/do/<uniqueKey>/<objectId>.sqlite
```

`uniqueKey` is `${resource.id}-${className}` and is never regenerated, so
renaming or redeploying a worker cannot orphan its objects' storage.

Each namespace directory also contains Miniflare's own `metadata.sqlite`. It is
not an object and has no `_cf_METADATA` table.
