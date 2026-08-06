# 0009. Caddy as the HTTP front door, run as a managed container

Status: ACCEPTED
Date:   2026-08-07

## Context

Studio is network exposed (ADR 0008) and therefore needs TLS. Phase 2 adds
deployed apps, each of which wants a hostname, and Phase 2 users will want custom
domains. Something has to terminate TLS and route HTTP.

Note first what this is **not** for. Postgres is not HTTP. Wake-on-connect on
5432 requires parsing the startup packet to learn which project is being asked
for, and no reverse proxy does that. The keystone stays in `@hobby.sh/proxy`
regardless of what fronts HTTP.

Three candidates: Caddy, nginx, or terminating TLS in our own daemon with an
embedded ACME client.

## Decision

**Caddy, run as a container Hobbyist manages, configured entirely over its admin
API.**

Nothing is installed on the host. There are no Caddy config files on disk for a
user to hand-edit or for us to template. The daemon posts configuration to the
admin API and routes exist immediately.

## Reasoning

The deciding property is runtime reconfiguration. Projects and apps get created
and destroyed constantly. With nginx, each change means rendering a config file
and triggering a reload, which is a config-generation subsystem we would maintain
for the life of the project. With Caddy it is an API call.

Second is on-demand TLS. In Phase 2 a user points `myapp.example.com` at their
box, and Caddy asks our daemon whether that hostname is real before issuing a
certificate on the first request. nginx requires every certificate provisioned
ahead of time, which does not fit a system where hostnames appear at runtime.

Running it as a container rather than a host package removes the install step
that differs across Debian, Alpine and macOS, which is exactly the friction the
one-command promise exists to kill.

Terminating TLS ourselves was rejected because certificate issuance, renewal and
their 3am failure modes are a solved problem we would be re-solving.

## Consequences accepted

- **A Go binary sits in the runtime picture** of an otherwise TypeScript project
  (ADR 0006). One language in our source tree, not one language on the box.
- **Ports 80 and 443 are published from a container we manage**, and `hobby init`
  has to detect and report a conflict with anything already bound there.
- **`hobby eject` must emit the Caddy configuration** alongside the compose file,
  or the ADR 0003 promise leaks. An ejected app that no longer serves is not an
  ejected app.
- **Caddy does not trigger wakes.** It can hold a request while an upstream comes
  up, but nothing in it knows to start a sleeping container. The wake trigger
  stays in our router, so the Phase 2 request path is client, Caddy, our router,
  wake, upstream. This is unverified and gets measured before Phase 2 design is
  final.
- **The admin API is a control surface on the box.** It binds to loopback and is
  reachable only by the daemon.

## What would have to change to revisit

The admin API proving unstable under frequent reconfiguration, or the container
adding latency to every request that is measurable against the cold start budget.
Either would push toward terminating TLS in the daemon after all.
