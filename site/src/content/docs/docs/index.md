---
title: What Hobbyist is
description: A self-hosted platform that feels like Neon and Supabase, on hardware you own. Everything sleeps when nothing is using it and wakes when something connects.
---

<p class="state state--starting">v0-alpha, not production ready</p>

Hobbyist is a convenience layer over primitives you already have. Postgres,
containers, and a reverse proxy are all free and mature. What managed platforms
sell on top of them is instant provisioning, a connection string that just
works, a dashboard that makes a database legible, and a deploy that happens on
push. That convenience is the only thing missing from the self-hosted world, and
it is the whole of what this builds.

One command gives you a project with a Postgres in it. Everything sleeps when
nothing is using it and wakes when something connects. It runs on one box, with
no Kubernetes, and you can walk away from it at any time with a single command.

## Read this part before you install anything

This is v0-alpha. **Postgres is the part that is reliably configured and
working.** The rest ranges from verified-but-young to openly broken, and the
[status page](/docs/status/) names which is which. There is no warranty and no
support obligation. Do not put data you cannot afford to lose in here without
your own backups, which today means `pg_dump`, because
[snapshots are built and not yet reachable](/docs/status/#not-built-yet).

## The wedge

**Everything sleeps, and everything wakes on demand.** This is the single reason
for the project to exist, and it is the one thing no self-hostable alternative
does. Self-hosted Supabase never sleeps. Xata's open-source scale-to-zero plugin
cannot wake a database, which is why reactivation stayed in their paid cloud.
Coolify and Dokploy deploy apps well and never sleep them.

Sleep is what makes ten projects fit on one small box. Wake is what makes sleep
invisible. [How it works](/docs/concepts/sleep-and-wake/).

## The three promises, in priority order

1. **You can always leave.** The data directory is a plain Postgres data
   directory. `pg_dump` always works. `hobby eject` hands you a
   `docker-compose.yml` and the data, and gets out of the way.
2. **It runs on one box.** A five dollar VPS, a Mac Mini, an old ThinkPad under a
   desk. If a feature requires a cluster, it is out of scope.
3. **It feels good.** The reason people pay for managed platforms is ergonomics.
   Matching the primitives is not enough; matching the feel is the entire job.

When those conflict, the earlier one wins.

## What it is not

It is not a business. There is no cloud offering, no hosted tier, no paid
feature, no metering and no billing, and no roadmap toward one. That is
load-bearing rather than a disclaimer: it removes multi-tenancy, isolation
hardening, usage accounting and quota enforcement from scope, and those removals
are what make the project buildable by one person.

It also means several things are permanently out of scope, and adding them needs
[a decision record](/docs/decisions/) arguing the case: Kubernetes and
clustering, multi-tenancy across different owners, end-user auth as a service,
realtime subscriptions, edge execution, DNS and secrets management.

## Where to go next

- [Install](/docs/install/), and what the installer actually does to your box.
- [Your first project](/docs/first-project/), from nothing to a connection
  string.
- [Alpha status and known gaps](/docs/status/), the honest inventory.
- [Comparison and pricing](/compare/), against Neon, Supabase, Fly.io and
  Cloudflare.
