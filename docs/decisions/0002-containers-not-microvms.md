# 0002. Containers, not microVMs

Status: ACCEPTED
Date:   2026-08-06

## Context

Firecracker-style microVMs were an early part of the vision, borrowed from how
serverless platforms run isolated compute. They boot in around a hundred
milliseconds and give hardware-level isolation between tenants.

The question is what that isolation is protecting against here.

## Decision

**v1 uses containers.** The compute runtime sits behind an interface in
`@hobby.sh/core` so a microVM implementation can be added later without a
rewrite, but that implementation is not written now.

## Reasoning

MicroVM isolation exists to run **untrusted, multi-tenant** workloads safely. On
a machine the user owns, running databases the user created, every tenant is the
same person. The isolation protects against nothing that is actually present.

What it costs is real: a kernel boot, a device model, network plumbing, an image
build pipeline, and a much harder story for anyone trying to run this on a Mac
Mini or an arbitrary VPS.

Containers start faster, are already installed on the target machines, and are
understood by the audience.

This is a case of importing a requirement from a business model that was
explicitly rejected. Multi-tenancy is what makes microVMs necessary, and there is
no multi-tenancy here.

## Consequences accepted

- Weaker isolation between instances on the same host, which is acceptable
  because they share an owner.
- A dependency on a container runtime being present, which is a far smaller ask
  than KVM access. Note that some cheap VPS tiers do not expose nested
  virtualisation at all, so requiring microVMs would have excluded a meaningful
  part of the audience outright.

## What would have to change to revisit

Hobbyist would have to be running untrusted workloads from multiple parties on
shared hardware. In practice that means a hosted offering, which is explicitly out
of scope. If that ever changes, this ADR gets superseded, and the runtime
interface is the reason that is a contained change rather than a rewrite.
