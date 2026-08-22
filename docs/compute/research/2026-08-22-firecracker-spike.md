# Firecracker measured, not argued

Status: NOTES, measured 2026-08-22 on a DigitalOcean `1vcpu-1gb` on ext4.
**Two results reverse the intuition the proposal rests on. One result is the
best cold start this project has ever recorded.**

The proposal was: keep Postgres and workerd in Docker, move apps to Firecracker
microVMs, on the reasoning that microVMs boot faster. ADR 0002 declined
microVMs in 2026-08 on isolation grounds, and its stated revisit condition
(untrusted multi-tenant workloads) has not occurred. So rather than re-argue the
ADR, this spike ran the thing.

Everything below is one box, one afternoon, the same application image that
produced the published 1828ms figure.

## What was run

| Piece | Version |
|---|---|
| Box | DigitalOcean droplet, NY, 1 vCPU, 961MB RAM, 2GB swap, 24GB ext4 |
| OS | Ubuntu 24.04.4 LTS, x86_64 |
| Firecracker | v1.16.1, official release binary |
| Guest kernel | `vmlinux-6.1.155`, Firecracker CI artifact `v1.15/x86_64` |
| Docker | 29.7.2 |
| App image | `hobby/bench-nxt:1787392549`, the `nextjs` fixture, Next.js 15 standalone on `node:22-alpine` |

`/dev/kvm` is present on the droplet and `kvm_intel.nested` is `Y`, so the
availability worry recorded in ADR 0002 ("some cheap VPS tiers do not expose
nested virtualisation at all") does not hold on DigitalOcean. It may still hold
elsewhere; Hetzner Cloud and Vultr were not checked.

## The three numbers that matter

Same box, same image, same hour, same harness shape: stop it, then measure wall
clock from process spawn to a real HTTP 200.

| Path | n | min | p50 | max |
|---|---|---|---|---|
| Docker `docker start` | 12 | 2460ms | **2678ms** | 3724ms |
| Firecracker cold boot | 12 | 4757ms | **5042ms** | 5419ms |
| Firecracker snapshot restore | 12 | 424ms | **442ms** | 1605ms |

Read the first two rows before the third.

**Firecracker cold boot is 1.9x slower than Docker for this application.** Not
faster. The microVM has to boot a kernel, mount an ext4 root over virtio-blk,
and then read a 129MB `node` binary and the application through that virtual
block device. Docker starts a process against a page cache the host is already
holding. Whatever a microVM saves on isolation setup, it more than gives back on
first-touch I/O for anything with a large runtime.

The Docker p50 here is 2678ms against the 1828ms filed earlier the same day.
Both are honest. The difference is box state: this run had 512MB of snapshot
memory file competing for page cache, and it measures from `docker start`
including the CLI process spawn rather than through the daemon's API. The
comparison that matters is within this table, where every row paid the same
conditions.

**Snapshot restore is 6x faster than Docker start, and 11x faster than
Firecracker cold boot.** 442ms p50, comfortably inside the 1 second target that
every Next.js wake has missed until now. The restored VM serves the real page:
HTTP 200, 3970 bytes of rendered Next.js HTML, 20ms to 67ms warm.

That single row is the entire case for microVMs here, and it has nothing to do
with isolation or with boot speed. It is that a paused VM's memory can be mapped
back in, so the 1395ms of Node and Next.js startup is never paid a second time.

## Why the intuition was wrong

The decomposition filed earlier said a Next.js wake is roughly 21% container
start and 79% application boot. That is still true. What the spike adds is that
Firecracker does not reduce the 21%: on this hardware it enlarges it.

Guest-side instrumentation, kernel uptime read inside `/init`:

- Kernel reaches `/init` at **0.300s** with `quiet loglevel=1`.
- Network configured at 0.300s, so `ip addr add` costs nothing measurable.
- Host observes HTTP from a busybox guest at **504ms p50** (n=10, min 485ms).

So the microVM floor is 504ms against Docker's 386ms floor for the equivalent
busybox fixture. Firecracker's widely quoted ~125ms boot is real, and it is the
product of a purpose-built minimal kernel. The stock CI kernel used here is a
43MB `vmlinux` with iSCSI, IPv6 segment routing, vsock, zswap and bpfilter
compiled in, and it spends 300ms initialising them. Getting to 125ms means
building and maintaining a kernel config per architecture, which is work that
does not appear in any comparison table.

## Two measurement artifacts worth recording

Both cost real time to find, and both would have produced a published number
that was wrong.

**Serial console logging costs 1020ms.** With `console=ttyS0` and default
loglevel, the busybox floor is 2113ms p50. Adding `quiet loglevel=1` takes it to
1093ms. Nothing else changed. Any Firecracker benchmark that does not say which
it used is not comparable to any other.

**ARP resolution costs about 580ms.** The host has no neighbour entry for a
guest that does not exist yet, so the first connect attempt after the guest
comes up can still be waiting behind a pending ARP request. Installing a
permanent neighbour entry for the guest MAC took the floor from 1093ms to 504ms.
This is not a Firecracker cost, it is a cost any wake router built on tap
devices would pay unless it pre-populates the neighbour table, which is a thing
Docker's bridge does for you.

## What snapshot restore actually costs

The 442ms is not free, and three of the costs land squarely on this project's
stated constraints.

**Disk, per sleeping app:**

| Artifact | Apparent | Actual blocks |
|---|---|---|
| `nxt.ext4` root filesystem | 1.5G | 252M |
| `mem.file` memory snapshot | 512M | 512M |
| `snapshot.file` VM state | 13K | 16K |
| `vmlinux` guest kernel (shared) | 43M | 43M |

That is roughly **764MB on disk per sleeping app**, and unlike Docker the root
filesystems do not share layers: ten apps on `node:22-alpine` are ten full
copies of Alpine and Node, not one shared base plus ten thin writable layers.
"Ten projects fit on one small box" is a load-bearing claim in `CLAUDE.md`, and
ten sleeping apps here is 7.6GB before any data.

**Cold page cache, first restore: 1605ms.** Run 1 of 12 was 1605ms; runs 2
through 12 were 424ms to 490ms. The difference is whether the 512MB memory file
is in host page cache. On a 961MB box that cache is contended, so the honest
figure for an app nobody has touched in a day is closer to the 1605ms than the
442ms. This spike did not measure restore after a deliberate `drop_caches`, and
it should before any number is published.

**The guest clock is frozen at the snapshot instant.** Measured directly off the
`Date` header the guest generates:

```
host  Date: Sat, 22 Aug 2026 12:18:41 GMT
guest Date: Sat, 22 Aug 2026 12:17:17 GMT
--- after 3s ---
host  Date: Sat, 22 Aug 2026 12:18:44 GMT
guest Date: Sat, 22 Aug 2026 12:17:20 GMT
```

84 seconds behind, and the skew is constant: the guest resumes counting from
where it was paused rather than catching up. For an app asleep 8 hours, every
JWT expiry check, cache TTL, cookie lifetime, log line and `now()` written into
a row is 8 hours wrong.

Firecracker documents this and ships mitigations (VMGenID, and a `vmclock`
device which this kernel does register). Both require something inside the guest
to notice and re-sync. That means the user's image has to carry a clock agent.
`packages/app/src/app.ts` currently describes its single environment
requirement as "the one thing we ask of the user's image", and this would be the
second, larger thing.

The same class of hazard applies to entropy and to open sockets. Not measured
here, but a restored app holding a Postgres connection pool holds sockets the
kernel on the other end has long since forgotten. The fixture used has no
database, so this spike says nothing about it, and it is the case Hobbyist apps
will be in most of the time.

## A bug the spike hit, kept because it generalises

The first Next.js microVM panicked immediately:

```
[    0.341538] panic+0x102/0x2a0
[    0.341538] do_exit.cold+0x15/0x15
...
RDI: 000000000000007f
```

`RDI` is 0x7f, so init exited 127, command not found. The kernel hands `/init`
an empty environment, and the init script called `mount` and `ip` by bare name.
Docker sets `PATH` from the image config before exec; a microVM does not,
because there is no image config, only a block device.

That is the whole OCI-to-rootfs problem in one line. `docker export` gives the
filesystem and throws away `Entrypoint`, `Cmd`, `WorkingDir` and `Env`. Every
one of those has to be re-materialised into a generated init, and every image
that expects an init system, a `/dev` populated by udev, or a resolvable
`/etc/resolv.conf` fails differently.

## What this does not answer

- No ARM. `aarch64` needs its own kernel and was not built.
- No macOS, and there is no path to one: Firecracker requires KVM. A Mac Mini is
  named as a target box in `CLAUDE.md`, so the Docker path cannot be retired.
- No concurrency. One VM at a time on one tap device. Networking for N
  simultaneous microVMs (bridge, IPAM, DNAT for published ports, and a
  replacement for Docker's embedded DNS, which `app.ts:82` currently depends on
  to resolve a sibling database by container name) is untested and is the
  largest single piece of work.
- No restore after `drop_caches`, per above.
- No app with a database, so the stale-socket question is open.
- Snapshot creation itself took 2130ms, which is paid at sleep time rather than
  wake time, but is not nothing on a box that is also serving.

## What this changes

The proposal as stated, swap the app runtime from Docker to Firecracker, is
measurably a regression: 2678ms becomes 5042ms, plus a second runtime to
maintain, plus 764MB per sleeping app, plus no macOS.

The proposal one layer down, keep the app runtime as it is and add
snapshot and restore, is the best result this project has measured: 442ms for a
Next.js app that has never once come in under 1600ms by any other route.

Those are different projects. The first is a runtime port. The second is a
hibernation mechanism, and it is what "everything sleeps and everything wakes"
was always reaching for. Firecracker matters to the second only because its
snapshot support is mature while Docker's CRIU checkpoint has been experimental
since 2016.

Before anything is built, the open questions above (cold page cache, clock
resync, stale sockets, concurrent networking) need answers, because each of them
can turn 442ms back into a broken app. An ADR arguing snapshot and restore for
cold start, superseding nothing and citing this file, is the right next
artifact.

## Reproducing

Scripts are on the box at `/root/fc-spike/`: `measure.sh` (cold boot loop),
`split.sh` (single boot with guest instrumentation), `snap-create.sh`,
`snap-restore.sh`, `docker-measure.sh` (the Docker comparison), `mkrootfs.sh`
(OCI image to ext4). They are throwaway spike code, not committed, and they
assume `tap0` at 172.30.0.1/24 with a permanent neighbour entry for
06:00:AC:1E:00:02.
