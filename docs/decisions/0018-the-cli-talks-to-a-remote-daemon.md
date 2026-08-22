# 0018. The CLI talks to a remote daemon, over the same API, with tokens

Date: 2026-08-22
Status: ACCEPTED

## Context

The CLI reaches the daemon over a unix socket, so it has always had to run on
the daemon's own box. `claude_docs/ACTIVE_CONTEXT.md` has carried "C: remote
deploy" as an unstarted sub-project since Phase 2, noting it needs its own
decision because a socket with filesystem permissions is not an authentication
story once it becomes a network service.

The pieces to build on already exist. The daemon's TCP listener is wrapped in
`createStudioApp`, which applies a session gate to every `/v1/` route, and that
gate was measured holding over a tailnet on 2026-08-22. So the control plane is
already an authenticated HTTP API. What is missing is a credential a program can
hold, and a client that knows how to use one.

## Decision

**The CLI gains a second transport, and nothing else changes.**

`hobby login <url>` exchanges the operator password for a long-lived API token
and stores it. When a remote is configured the CLI talks HTTP to that URL; with
no remote it uses the unix socket exactly as before. Every verb works either
way, because both transports speak the same API, which is the seam the root
`CLAUDE.md` already names as the reason the CLI and MCP cannot diverge.

**Tokens, not the session cookie.** Cookies exist for browsers: they carry
`SameSite`, an expiry a browser enforces, and a CSRF story a CLI does not need.
A token is a bearer credential a program can hold, revoke by name, and keep out
of a cookie jar.

Tokens are:

- **Issued on the box**, by `hobby token create <name>`, or by `hobby login`
  presenting the operator password.
- **Shown once.** Only a hash is stored, the same argon2id already used for the
  operator credential, so the state file is not a list of live credentials.
- **Named and listable**, so `hobby token ls` and `hobby token rm <name>` mean
  something when a laptop is lost.
- **Sent as `Authorization: Bearer`**, checked in the same place the session
  cookie is checked, so there is one gate rather than two.

**Project scope lives in `hobby.json`.** `hobby link <project>` writes the
project name into the `hobby.json` found by walking up from the working
directory, which is the file `resolveConfig` already reads. After linking,
`hobby deploy` and the rest default to that project, so a directory knows which
project it belongs to and the commands stop needing `--project`.

## Why the credential does not go in hobby.json

`hobby.json` is a project file. It belongs in a repository, it gets committed,
and it is read by a walk up from the working directory, which means any
directory below it inherits whatever it contains.

Tokens go in `$HOBBY_HOME/credentials.json`, mode 0600, one entry per remote.
That file is per-machine, never per-project, and is not something a `git add -A`
can sweep up.

## Consequences

- The daemon's TCP listener has to be reachable, which means the operator
  chooses an exposure the same way ADR 0017 makes them choose one for the proxy.
  The documented answer is a tailnet, and `tailscale serve` in front of the
  daemon already works and is measured.
- A token is as powerful as the operator password: it can create and destroy
  every database on the box. There are no scopes and no read-only tokens in this
  decision, because one operator with several machines is the case, and scopes
  without a second principal to give them to are ceremony.
- Revocation is immediate and by name, and losing the box's state file logs
  every machine out, which is the correct direction to fail.
- MCP is unaffected and stays on the socket. Nothing about this makes it a
  network service.

## What this deliberately does not do

- **No accounts.** One operator, as ADR 0008 already decided.
- **No token scopes or expiry.** A token is revoked by name when it should stop
  working. Adding expiry means adding renewal, and renewal is a background
  process nobody asked for.
- **No transport security of its own.** The token is a bearer credential and
  must not cross a network the operator does not trust. It is sent to whatever
  URL `hobby login` was given, so that URL should be HTTPS, which over a tailnet
  it is.
