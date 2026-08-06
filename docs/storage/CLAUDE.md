# `docs/storage/` buckets and volumes

**Status:** PROPOSED. Nothing built. **Phase 3.**

Two resource kinds that are unrelated to each other and share a folder only
because they are both disk.

| Kind | What | For |
|---|---|---|
| `bucket` | S3-compatible object storage | Application files: uploads, images, documents |
| `volume` | A persistent directory attached to a compute resource | Compute that genuinely needs local disk |

## Buckets: wrap, do not write

**We are not writing an object store.** MinIO, Garage and SeaweedFS exist, are
mature, and hold people's files correctly. The work here is provisioning,
credentials, lifecycle and making it feel like one line in the CLI, exactly as
`docs/backups/` wraps pgBackRest rather than reimplementing it.

Choosing between them, and documenting why, is the first task in this folder.

## Volumes exist because compute is stateless

Phase 2 compute has no persistent disk on purpose. This is where that gets
undone, in a later phase, once the compute runtime is proven. A volume is boring:
a host directory, bind mounted, with a lifecycle tied to its project rather than
to the container.

## The sleep question, which is the hard one

The wedge is that everything sleeps. Storage does not obviously sleep, and that
tension is the main open design problem in this folder rather than a footnote:

- An object store daemon that runs permanently to serve occasional requests is a
  resident cost on a small box, which is what the wedge exists to eliminate.
- Waking it on the first request is possible, since S3 is HTTP and the router
  already handles HTTP wake by Phase 2.
- A volume cannot sleep at all. It is a directory. The compute attached to it
  sleeps, and the disk stays.

## In scope

- Choosing the object store, and documenting why
- The `bucket` and `volume` resource kinds
- Credential issuance and scoping per project
- Backup interaction: buckets need backing up too, and `docs/backups/` currently
  assumes Postgres
- Branching interaction: what a branched project does about its buckets, which is
  a genuinely hard question with no obvious right answer

## Out of scope

- Writing an object store
- A file API with image transforms on top of the buckets. That is a Supabase
  Storage feature, it was considered and is not in the phase plan, and it needs
  its own ADR if it is ever wanted.
- Cross-host replication or erasure coding. One box.

## Open questions

- Does a bucket sleep, and if so what wakes it?
- What happens to a bucket when its project is branched? Copy on write, share, or
  refuse?
- Do volumes get reflink-cloned during branching the way a data directory does?
