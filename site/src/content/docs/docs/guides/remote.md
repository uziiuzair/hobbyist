---
title: Using it from your laptop
description: Install the CLI on your own machine, connect it to your box, and run every command from where you actually work.
sidebar:
  order: 0
---

<p class="state state--running">works</p>

Everything the CLI does on the box, it can do from your laptop. Same commands,
same output. This is the setup.

## First, the box has to be reachable

The daemon binds `127.0.0.1` and stays there, deliberately: it is a control
plane that can create and destroy databases, so it does not put itself on a
network. Something you choose has to bridge it.

**Tailscale is the recommended answer**, and it is one command on the box:

```sh
tailscale serve --bg 7432
```

That publishes it at your machine's tailnet name over HTTPS, reachable by your
devices and nothing else. [More on tailnets and tunnels](/docs/guides/tailscale-and-tunnels/).

An SSH tunnel works too, and needs nothing on the box:

```sh
ssh -L 7432:127.0.0.1:7432 you@your-box
```

Then the URL below is `http://127.0.0.1:7432`, which is allowed over plain HTTP
because it never crosses a wire.

## Then log in

On your laptop:

```sh
hobby login https://your-box.tailnet.ts.net
```

It asks for the operator password, the one set by `hobby studio passwd` on the
box, and exchanges it for an API token. The password is not stored and never
echoes.

From here every command runs against that box:

```sh
hobby ls
hobby new blog
hobby deploy ./site --project blog
```

## Link a directory to a project

So you stop typing `--project`:

```sh
cd ~/code/blog
hobby link blog
```

That writes `{ "project": "blog" }` into `hobby.json` in that directory, and
commands run from there default to it. The file is meant to be committed: it
says which project this repository belongs to, and it holds no secret.

Your token is **not** in it. Credentials live in `~/.hobby/credentials.json` at
mode 0600, per machine, precisely so a `git add -A` cannot sweep one up.

## Several boxes

`hobby login` against each, then:

```sh
hobby remote ls                    # which ones, and which is current
HOBBY_REMOTE=https://other-box.ts.net hobby ls    # aim one command elsewhere
```

## Revoking

On the box:

```sh
hobby token ls
hobby token rm laptop
```

That machine is locked out on its next request. `hobby logout` on the laptop
only forgets the token locally; it does not revoke it, and the output says so.
If a laptop is lost, revoke on the box.

## What a token can do

Everything. A token is as powerful as the operator password: it can create and
destroy every database on the box. There are no read-only tokens and no scopes,
because [one operator with several machines is the case](/docs/decisions/0018-the-cli-talks-to-a-remote-daemon/)
and scopes without a second person to grant them to are ceremony.

Two consequences worth holding on to. Send a token only to a URL you trust, which
is why `hobby login` refuses plain HTTP to anything but loopback. And revoke by
name the moment a machine stops being yours.
