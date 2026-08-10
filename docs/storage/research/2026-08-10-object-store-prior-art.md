# Object store prior art, and what Supabase self-hosted actually runs

Status: NOTES. Phase 3 is years away. Filed now because the evidence was in hand
and the choice named in `docs/storage/CLAUDE.md` will otherwise be made from
memory.
Date:   2026-08-10

`docs/storage/CLAUDE.md` states that we are not writing an object store, that the
work is provisioning and credentials and ergonomics, and that **choosing between
MinIO, Garage and SeaweedFS and documenting why is the first task in the folder.**
This file is evidence toward that task and nothing more.

## `supabase/storage` is the shape we would be building

Apache 2.0, TypeScript, roughly 1.3k stars, described as "S3 compatible object
storage service that stores metadata in Postgres".

That is precisely the `bucket` resource kind: a thin service in front of a real
object store, with the metadata living in a Postgres we already run. It is the
closest existing implementation of the Phase 3 work, in our language, under a
licence that permits reading and taking.

One boundary to hold when reading it. `docs/storage/CLAUDE.md` puts "a file API
with image transforms on top of the buckets" out of scope, naming it as a
Supabase Storage feature that was considered and rejected without its own ADR.
That feature is inside this repository, it is attractive, and it is the obvious
way scope creeps in from this direction.

## The self-hosted stack has two object store options now

`supabase/supabase` at `docker/` ships both:

- `docker-compose.s3.yml`, running MinIO from `cgr.dev/chainguard/minio` with a
  `chainguard/minio-client` sidecar that creates the bucket.
- `docker-compose.rustfs.yml`, running `rustfs/rustfs:1.0.0-beta.11` with an
  `rustfs/rc` sidecar doing the same job. It reuses the `MINIO_ROOT_USER` and
  `MINIO_ROOT_PASSWORD` environment variables, which reads as a drop-in
  substitution rather than a parallel feature.

Two facts worth carrying forward. Supabase no longer runs the upstream MinIO
image, and they have shipped a beta alternative alongside it. Neither tells us
their reasoning, and this file does not speculate about it. It does mean that
"MinIO, Garage or SeaweedFS" as stated in `docs/storage/CLAUDE.md` is an
incomplete candidate list, and RustFS belongs on it when the choice is actually
made.

The composes also confirm something already recorded in ADR 0009 from a different
angle: `docker/` now contains `docker-compose.caddy.yml` alongside the Envoy and
Nginx variants. Caddy as the self-hosted front door is not an unusual choice.

## Not applicable

`cloudflare/serverless-registry` (Apache 2.0, TypeScript) is a container registry
backed by R2 and Workers. It looks adjacent to both this folder and
`docs/compute/`, and it is not: it depends on Workers and R2 as platform
primitives, so there is nothing portable in it for a single box.

## The sleep question is still open, and nothing here answers it

`docs/storage/CLAUDE.md` names the tension as the main open design problem: an
object store daemon that runs permanently to serve occasional requests is exactly
the resident cost the wedge exists to eliminate.

Neither `supabase/storage` nor MinIO nor RustFS sleeps. None of them was built
for a box where sleeping is the point. If buckets are to sleep, that logic is
ours to write, on the HTTP wake path the router gains in Phase 2, and no prior
art surveyed here helps with it.
