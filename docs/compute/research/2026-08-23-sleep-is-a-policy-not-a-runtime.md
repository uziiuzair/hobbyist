# Sleep is a policy, not a runtime

Status: NOTES, measured 2026-08-23 on a DigitalOcean `1vcpu-1gb` on ext4, same
box and same `hobby/bench-nxt` image as the Firecracker spike.

Started as "what about LXC", ended somewhere more useful. The short version is
that the interesting axis is not which thing executes the workload. It is what
"asleep" means, and today that decision is welded to the runtime because
`ComputeRuntime` only offers `start` and `stop`.

## LXC specifically

LXC 6.0.0 is installable on Ubuntu 24.04 (`lxd` is not). It adds close to
nothing here:

- **Its checkpoint is CRIU**, which
  [the Firecracker spike](2026-08-22-firecracker-spike.md) already established
  has no installation candidate on this OS.
- **Its freezer is the cgroup v2 freezer**, which Docker already exposes as
  `docker pause`. Nothing about it requires LXC.
- **Its actual differentiator is system containers**, a full init running
  systemd inside. Hobbyist runs one process per resource on purpose, so this is
  a cost rather than a feature.

Everything LXC would have given this project is already reachable through the
runtime it has.

## The third state, measured

Freeze the process tree with the cgroup v2 freezer, then push its anonymous
pages out with `memory.reclaim` (kernel 5.19+, this box is on 6.8). The process
never exits, so none of the ~1395ms of Node and Next startup is re-paid, and
there is no memory file on disk.

Single app, host page cache dropped before every wake:

```
awake  memory.current: 104MB
frozen memory.current:   2MB
unfreeze, cold cache:  n=5  min=1617ms  p50=1754ms  max=3367ms
```

Four apps at once on the same 961MB box:

| | sum of cgroup `memory.current` | host used | host available |
|---|---|---|---|
| 4 awake | 214MB | 610MB | 350MB |
| 4 frozen and reclaimed | **8MB** | 462MB | 499MB |

Waking one of the four with a cold page cache: **1534ms**. Swap held all four in
300MB. The served body is still 3970 bytes of real Next.js HTML.

**The guest clock is exact.** `Date` header from the woken app matched the host
to the second, because the process was descheduled rather than stopped and the
kernel's clock never paused. This is the single sharpest difference from a VM
snapshot, which was measured at 84 seconds behind with constant skew.

## Four sleep policies, one table

Every number here is measured on the same box, same image, same conditions,
except where marked.

| Policy | Cold wake | RAM while asleep | Disk while asleep | Survives host reboot | Guest clock | Open sockets |
|---|---|---|---|---|---|---|
| `never` | none | full (104MB) | none | n/a | correct | kept |
| `freeze` | **1754ms** | **2MB** | swap only | **no** | correct | **kept** |
| `stop` (today) | 3635ms | none | none | yes | correct | dropped |
| `snapshot` (Firecracker) | 1473ms | none | **+764MB** | yes | **84s skew** | dropped |

Read the `freeze` row against the `snapshot` row. Firecracker restore is 281ms
faster and that is the entire advantage. Against it: a second runtime, an
OCI-to-rootfs pipeline, replacement networking and DNS, no macOS, 764MB per
sleeping app, and a clock that needs an agent inside the user's image. Freeze
costs one field and a state mapping fix.

What `snapshot` genuinely wins is durability. A frozen container is a live
process tree, so a host reboot loses it and the app falls back to a cold start.
A snapshot on disk does not care. That is a real difference and it is the honest
argument for keeping the Firecracker work on file rather than deleting it.

`freeze` also holds its port bindings, network namespace and PID slots while
asleep, so "asleep" is cheaper in memory than `stop` but not free in every
resource. At 2MB per app that trade looks strongly worth it.

## What has to change in the code

**`ContainerStatus` has two states and needs three.**
`packages/core/src/docker.ts:83` maps `running: state?.Running ?? false`. Docker
reports a paused container as:

```
Status=paused Running=true Paused=true ExitCode=0
```

So a frozen container reads as awake. The hibernator would see it as a wake
candidate and the reconciler would see it as healthy. Nothing about the current
model can express "present, not executing, resident in swap".

That is the actual work: a third state on `ContainerStatus`, a `freeze`/`thaw`
pair alongside `start`/`stop` on `ComputeRuntime` (optional, in the same way
`build` is optional and for the same reason), and a `sleep` policy field on the
resource that the hibernator reads instead of assuming `stop`.

## Why this is the better abstraction

Two axes have been getting conflated:

1. **What executes the workload.** Docker, Firecracker, LXC, podman. This is
   `ComputeRuntime`. Replacing it means reimplementing networking, name
   resolution, port publishing, log capture and image building, which the
   Firecracker spike costed at 5 to 7 weeks for parity with what already works.
2. **What "asleep" means.** `never`, `freeze`, `stop`, `snapshot`. This is not
   the runtime. It is a policy, it is one field, and the table above shows there
   are at least four defensible points on it with genuinely different tradeoffs.

Today axis 2 does not exist, because `ComputeRuntime` offers only `start` and
`stop` and so the policy is whatever the runtime's API happens to be.

Axis 2 is also the far better place to accept contributions. A sleep policy is
additive, testable against `createFakeRuntime` with no Docker in the loop, and
cannot break the existing path. A new runtime is a permanent maintenance
liability that has to reimplement six subsystems before it does anything a user
notices, on a project whose stated failure mode is being abandoned at 40 percent.

## Not everything should sleep

The policy axis answers this directly and the runtime axis does not. A resource
that should stay hot is `sleep: never`, which is a guard in the hibernator, not
a different execution engine. Anything the hibernator can be told to skip is
already supported by the shape above; it just has nowhere to be written down
right now.

## What this does not answer

- **No reboot test.** The claim that a frozen container does not survive a host
  reboot is reasoning from what a paused container is, not a measurement.
- **No app with a database.** Sockets are preserved across freeze, which should
  make a Postgres pool survive where a VM snapshot would not, but only if the
  database is awake on the other side. A frozen app whose database is stopped
  hits the gap recorded in
  [the sibling wake gap](2026-08-22-real-app-cold-start-and-the-sibling-wake-gap.md).
- **Variance is worse than Firecracker's.** One of five unfreezes took 3367ms
  against a 1617ms minimum. Firecracker restore held a 110ms spread. Five runs
  is not enough to characterise the tail.
- **No test above four apps**, and swap was not under pressure at that size.
- `memory.reclaim` was called six times with `64M` per freeze, chosen by hand.
  Nobody has worked out what the right call actually is.
