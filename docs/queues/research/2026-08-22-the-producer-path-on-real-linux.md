# The queue producer path on real Linux, measured at last

Status: NOTES, measured 2026-08-22 on a DigitalOcean droplet.
**Unresolved. The diagnosis is now complete and has a second half nobody knew
about.**

`docs/queues/CLAUDE.md` records the producer path as broken on Linux,
"established by reading the code, not by running it: no Linux box has been
touched." A Linux box has now been touched. The reading was right, and it was
half the story.

## Half one, as previously diagnosed: the name does not resolve

`packages/worker/src/worker.ts:216` hands every producer container:

```
http://host.docker.internal:7434/enqueue
```

`--add-host` appears nowhere in `packages/core`. Measured on Ubuntu 24.04,
Docker 29.7.2:

```
$ docker run --rm alpine:3.20 getent hosts host.docker.internal
  NOT RESOLVABLE

$ docker run --rm --add-host=host.docker.internal:host-gateway alpine:3.20 \
    getent hosts host.docker.internal
172.17.0.1        host.docker.internal
```

Confirmed. The container cannot resolve the name it is given, and the flag that
would fix it is never emitted.

## Half two, which is new: the daemon is not listening there either

`queueEndpointHosts` (`packages/cli/src/daemon/server.ts:121`) does the right
thing in principle. On Linux it asks Docker for each project's network gateway
and binds those alongside loopback, and its own comment explains exactly why a
socket bound only to 127.0.0.1 would never see that traffic.

It is a snapshot taken once, at daemon startup, over the projects that exist at
that moment. Its comment says so and calls the gap out honestly.

The problem is that the normal sequence puts every project on the wrong side of
that snapshot:

1. `curl https://hobby.sh/install | bash`
2. `hobby daemon &`
3. `hobby new blog`

Measured on the box:

| | |
|---|---|
| daemon started | Fri 21 Aug 23:37:22 |
| `coldstart` created | later, during a measurement run |
| `hobby-coldstart` network gateway | `172.18.0.1` |
| daemon actually bound on 7434 | **`127.0.0.1` only** |

So even with `--add-host` emitted, a producer resolving `host.docker.internal`
to `172.18.0.1` would connect to nothing. **Both halves have to be fixed for a
producer to work at all**, and only the first was previously known.

Anyone who creates a project after starting the daemon, which is everyone, is in
this state. Restarting the daemon closes it until the next project is created.

## The fix, both halves

**Container side.** Add an `extraHosts` field to `ContainerSpec`
(`packages/core/src/runtime.ts`), emit `--add-host=host.docker.internal:host-gateway`
from `buildCreateArgs` (`packages/core/src/docker.ts`) when it is set, and set
it for producer containers in `packages/worker/src/worker.ts`. Additive, and
harmless on macOS where the name already resolves.

**Daemon side.** The snapshot needs to stop being a snapshot. Three options,
and this is the part that wants a decision rather than a patch:

1. **Re-bind when a project is created.** Most correct, most work. The endpoint
   would need to add a listener for the new gateway at project-creation time,
   which means `createQueueEndpoint` growing an "also listen here" call and
   `createProject` knowing to make it.
2. **Bind the docker0 gateway too, and accept per-project networks are missed.**
   Cheap and wrong: project networks are 172.18+, docker0 is 172.17, so this
   fixes nothing for the actual case.
3. **Attach producer containers to a network whose gateway is already bound.**
   Sidesteps the problem instead of solving it, and cuts across the
   one-network-per-project design.

Option 1 is the only one that closes it. Not implemented here, deliberately:
shipping the container half alone would make the flag appear in `docker
inspect` while producers still failed, which is worse than the current state
where the gap is at least written down.

## What is still unmeasured

An actual `env.MY_QUEUE.send()` from inside a deployed worker on Linux. This
document establishes that it cannot work, from the two mechanisms above, and
did not run one. Doing so needs a worker with a producer binding deployed on
the box, which is worth doing once the fix lands so the fix has a test that
would have caught this.

Consuming is unaffected and was not retested here.
