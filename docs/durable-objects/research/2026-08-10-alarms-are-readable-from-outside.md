# Durable Object alarms are readable from a stopped runtime

Status: NOTES. Findings from reading `cloudflare/workerd` and from an
empirical probe against a running Miniflare. One finding corrects an
assumption made earlier the same day and is called out as such.
Date:   2026-08-10

The question this file answers: **can a Durable Object sleep?**

Not the object. workerd already idles individual objects inside a live process.
The question is whether the whole runtime can stop, the way a Postgres container
stops, and still honour an alarm set for 03:00. A stopped process has no timer.
If nothing outside the runtime knows the deadline, the choice is between a
runtime that never sleeps and an alarm that never fires, and both of those lose
the wedge.

The answer is yes, and it costs one SQL query.

## Where the schedule lives

`src/workerd/server/server.c++:404-408` constructs the scheduler:

```c++
KJ_IF_SOME(as, this->actorStorage) {
  // Create per-namespace alarm scheduler backed by on-disk storage in the
  // namespace directory, alongside the per-actor .sqlite files.
  this->ownAlarmScheduler = kj::heap<AlarmScheduler>(
      clock, timer, as.vfs, kj::Path({"metadata.sqlite"}), kj::mv(getActor));
}
```

Two facts in one comment. The scheduler is **per namespace**, and it is **backed
by a file on disk** rather than by process memory. `src/workerd/server/alarm-scheduler.c++:55`
gives that file's schema:

```sql
CREATE TABLE IF NOT EXISTS _cf_ALARM (
  actor_id TEXT PRIMARY KEY,
  scheduled_time INTEGER,
  actor_name TEXT
) WITHOUT ROWID;
```

and line 86 gives the read, with the units on line 91:

```c++
auto query = db->run(R"(
  SELECT actor_id, scheduled_time, actor_name FROM _cf_ALARM;
)");
...
auto date = kj::UNIX_EPOCH + (kj::NANOSECONDS * query.getInt64(1));
```

`scheduled_time` is **int64 nanoseconds since the Unix epoch**. That read happens
in the scheduler's constructor, which means workerd reloads and reschedules every
pending alarm at startup, without being asked.

That last part is what makes the whole design small. We do not have to fire
alarms. We have to be running when one is due, and workerd does the rest.

## Where the objects live

`src/workerd/server/workerd.capnp:722-731` documents the storage mode:

```
localDisk @12 :Text;
# ** EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE CHANGE **
#
# Durable Object data will be stored in a directory on local disk. This field is the name of
# a service, which must be a DiskDirectory service. For each Durable Object class, a
# subdirectory will be created using `uniqueKey` as the name. Within the directory, one or
# more files are created for each object, with names `<id>.<ext>` ...
```

`server.c++:388` is the code behind that sentence:

```c++
dir.openSubdir(kj::Path({d.uniqueKey}), kj::WriteMode::CREATE | kj::WriteMode::MODIFY));
```

**The `EXPERIMENTAL` marker is load-bearing and is repeated in the ADR.** This
layout is a documented-but-unstable interface, and the scanner is built to fail
loudly rather than silently when it changes. See "What breaks this" below.

## The probe

Reading the source says what workerd does. `@hobby.sh/compute` is standing up
**Miniflare**, not raw workerd (ADR 0011), and Miniflare is entitled to wrap
workerd's layout in a scheme of its own. That session said so explicitly and
asked that the layout not be hard-coded until confirmed. So it was measured.

**Method.** `miniflare@4.20260730.0` on Node, macOS (Darwin 25.3.0), two
SQLite-backed namespaces (`Room`, `Presence`), four objects addressed by name,
two of them setting alarms an hour and two hours out. `defaultPersistRoot`
pointed at an empty directory. Miniflare disposed, then the tree inspected with
`sqlite3`.

**Result.** Miniflare does not wrap it. The tree is workerd's, under a `do/`
subdirectory of the persistence root:

```
<persistRoot>/do/<uniqueKey>/<id>.sqlite        one file per object
<persistRoot>/do/<uniqueKey>/<id>.sqlite-wal
<persistRoot>/do/<uniqueKey>/<id>.sqlite-shm
<persistRoot>/do/<uniqueKey>/metadata.sqlite    the namespace's _cf_ALARM
```

and the alarm table held what the source predicted:

```
actor_id                            scheduled_time        actor_name
69426da5ac21d56c...9eaf361db6de     1786375171389000000   room-alpha
a8aa51bc7801b6e9...9b148cfff57c1    1786378771396000000   room-gamma
```

`1786375171389000000` nanoseconds is exactly the `1786375171389` milliseconds the
worker reported from `ctx.storage.getAlarm()`, so the unit conversion is
confirmed against a live value rather than inferred from a cast.

**`actor_name` holds the human name.** `room-alpha`, not only the hex id. That
was not obvious: `idFromName` is an HMAC and does not reverse, so the expectation
was a catalog that could only show opaque ids. `src/workerd/server/actor-id-impl.h`
explains why the name survives, in a comment on `idFromStringNamed`: the name is
"recovered from persistent storage" and reattached so `ctx.id.name` works inside
an alarm handler. Their reason for persisting it is our reason for being able to
display it.

### There are two copies of the alarm, and they agree

`src/workerd/util/sqlite-metadata.h` says:

> Class which implements a simple metadata kv storage and cache on top of
> SQLite. Currently used to store:
> * Durable Object alarm times (hardcoded as key = 1).

So a pending alarm exists in **two** places on disk, and the probe finds both
carrying the identical value:

```
$ sqlite3 69426da5….sqlite "SELECT key, value FROM _cf_METADATA;"
1|1786375171389000000            <- ActorSqlite's per-object copy
$ sqlite3 metadata.sqlite "SELECT actor_id, scheduled_time FROM _cf_ALARM;"
69426da5…|1786375171389000000    <- AlarmScheduler's per-namespace copy
```

**A first pass through this file claimed `_cf_METADATA` did not exist.** That
was a sampling error, and it is left recorded rather than quietly deleted
because the way it happened is instructive. The probe created three objects and
gave alarms to two of them, and the object file spot-checked was the third:

```
5a0c653c….sqlite   tables: msg                   <- room-beta, no alarm, no table
69426da5….sqlite   tables: msg _cf_METADATA      <- room-alpha, alarm
a8aa51bc….sqlite   tables: msg _cf_METADATA      <- room-gamma, alarm
```

`_cf_METADATA` is created lazily on first write (`ensureInitialized`, called
"not until the first write"), so an object that has never set an alarm has no
such table, and checking one file out of three found the one that proved the
opposite of the truth. The compute session, running the same question against
real Docker, reported `_cf_METADATA` present and forced the recheck.

### Which copy the mirror reads, and why

**`_cf_ALARM` in the namespace's `metadata.sqlite`.** Three reasons, none of
which is "the other one does not exist":

1. **It is the copy that actually causes a wake.** `AlarmScheduler`'s
   constructor selects every row from `_cf_ALARM` and reschedules it
   (`alarm-scheduler.c++:86-99`). `_cf_METADATA` is read when an actor is
   constructed, and an idle object is not constructed. So `_cf_ALARM` is the
   table that determines whether a restarted runtime fires anything.
2. **One file per namespace, not one per object.** A namespace with ten
   thousand objects is ten thousand file opens per poll on the other route.
3. **It carries `actor_name`.** That is the only place a human name is
   persisted anywhere on disk, and it is what lets the catalog show `room-alpha`
   rather than 64 hex characters.

`readObjectAlarm()` reads the per-object copy, and a test pins that the two
agree. If they ever diverge, the earlier deadline is the safe one: waking early
costs a cold start, waking late misses an alarm.

## Two more things the probe settled

**The namespace directory is `<uniqueKeyModifier>-<className>`.** Probe 1 saw a
bare `-Room` with no modifier configured. Probe 2 set the modifier to a
UUID-shaped string and got `8f14e45f-ceea-467a-9e73-8bdb0d1e1c2b-Room`. The
directory name therefore carries both the owning resource and the class, which
is what lets the catalog label a namespace without asking the runtime anything.
Parsing splits at the **last** hyphen, because a UUID contains hyphens and a
JavaScript class name cannot.

**A fired alarm deletes its own row.** Probe 2 set one alarm 300ms out and one an
hour out, waited, and disposed. Afterwards only the hour-out row remained, and
the fired object's own table had gained the row its `alarm()` handler writes. So
the table is self-cleaning, and a mirror that trusts it will not wake the runtime
forever on a deadline already in the past. Had this gone the other way, every
fired alarm would have become a permanent wake loop, which on a box whose whole
purpose is sleeping is the worst available failure.

## What breaks this

Honest list, because everything above rests on an interface upstream calls
experimental.

- **`localDisk` is marked `** EXPERIMENTAL; SUBJECT TO BACKWARDS-INCOMPATIBLE
  CHANGE **`** in `workerd.capnp:723`. The layout can change in a patch release,
  and `miniflare` ships most weeks.
- **`alarm-scheduler.c++:84` states its own intended scope:** "TODO(someday):
  don't maintain the entire alarm set in memory -- right now for the usecase of
  local development, doing so is sufficient." We would be leaning in daily use on
  a code path its authors describe as sufficient for local development. That is
  not a reason not to do it, since the data it writes is exactly what we need and
  the alternative is not sleeping at all. It is a reason to pin the version, to
  assert the schema at startup rather than assume it, and to expect this file to
  need revisiting.
- **A missing or renamed table must be an error, never an empty result.** The
  scanner asserts `_cf_ALARM` exists with the three expected columns and refuses
  to report "no alarms" when it cannot find the table. See the spec.

## Prior art not read yet

- `denoland/celld` (Apache 2.0, Rust): self-hosted distributed Durable Objects,
  embeds V8, one SQLite database per object, single-owner enforced by
  object-storage compare-and-swap, and its README claims "idle cells hibernate to
  nearly nothing". The closest existing work to this capability, and the only
  other project that has had to answer the alarms-across-sleep question. Its S3
  coordination is out of scope for one box, but its answer to scheduling is worth
  reading before the mirror is revisited.
- `VaalaCat/vorker`: workerd-based self-hosted Workers, Durable Objects marked
  experimental.
