# Contributing

Contributions are welcome. Before you spend real time on something, read this,
because the way this project is run is unusual in two ways that will affect
what happens to your patch.

## Two things to know first

**This is not a business, and it is one person's project.** There is no
company, no revenue, no support rota and no service level on anything,
including replies. An issue that sits unanswered for a while is not a slight,
it is one person's attention being finite. If something matters to you and has
gone quiet, saying so again is welcome.

**Scope is the main risk, not competition.** The root `CLAUDE.md` names the
failure mode plainly: a half-finished platform abandoned at 40 percent. Every
feature that gets refused is refused for that reason and not because it is a
bad idea. Most of them are good ideas. That is exactly the problem.

So the fastest way to have a change accepted is for it to be small, to be
something you actually hit while using the thing, and to not widen what the
project has to keep working forever.

## What is very likely to be accepted

- A bug you hit, with the reproduction you hit it with.
- A fix for something in the known gaps list, ideally with the measurement that
  proves it fixed.
- Documentation that corrects something wrong, or writes down something that
  was only ever true in someone's head.
- A cold start measurement on hardware nobody has measured yet. The five dollar
  VPS number in particular does not exist and the project's central claim is
  written against it.
- Anything that makes leaving easier: `hobby eject`, `pg_dump` paths,
  portability of the data directory.

## What needs an ADR before any code

Anything in the out-of-scope list in the root `CLAUDE.md`: Kubernetes,
clustering, multi-node, multi-tenancy across different owners, a hosted tier,
billing, metering, end-user auth as a service, realtime subscriptions, edge
execution, DNS or secrets management, Terraform providers, Helm charts.

The list is not a wall. It is a toll. Write `docs/decisions/NNNN-your-case.md`
arguing the case, open it as a pull request on its own, and let it be discussed
before you write the implementation. The record of what this project chose not
to build is more valuable than the record of what it did, because scope is what
kills it.

A new resource kind is the one large thing with a well-worn path: implement
`ResourceKindHandler` (`packages/core/src/kinds.ts`) and add one line to
`createDefaultKindRegistry`. Four kinds already exist to copy from.

## Working agreements the code is held to

These are not style preferences, they are what keeps the repository readable
by someone arriving cold.

- **No em-dashes.** Anywhere. Documentation, code comments, commit messages,
  program output. Use commas, colons, parentheses, or restructure the sentence.
- **Ground claims in code.** Cite `path/to/file.ts` and a symbol name rather
  than describing what you believe the code does. This applies to pull request
  descriptions as much as to comments.
- **Mark what is not real yet.** A reader must never execute an aspiration. If
  a document describes something unbuilt, it says so in the same breath.
- **Comments explain why, not what.** The existing comments are long and that
  is deliberate. Several of them exist because someone shipped a bug, and the
  comment is the only thing standing between you and shipping it again.
- **Prefer deleting a feature to deferring it.** A deferred feature still
  occupies attention.

## Running it

Requires Docker and Bun. See `docs/` and the installation guide for the full
prerequisites.

```sh
git clone https://github.com/uziiuzair/hobbyist
cd hobbyist
./install.sh          # prerequisites, build, launcher, hobby init
```

The checks CI runs, and the ones to run before opening a pull request:

```sh
npm run typecheck     # tsc --build --force across every package
npm test              # builds, then node --test over the compiled output
npm run build         # the above, plus the studio bundle
```

Tests are `node --test` against compiled output in `dist/`, not against
TypeScript sources, so `npm test` builds first. There is no separate watch
mode.

## Verifying against real Docker

The single most useful thing a contributor can do, and the thing this codebase
has been bitten by repeatedly: **run it, do not only test it.** Three of the
worst bugs found so far were found by running a container and none by a test
suite that was passing at the time. The clearest example is written up in
`packages/cli/src/daemon/reconcile.ts`: a TCP connect to a published container
port succeeds the instant the container is created, whether or not anything
inside is listening, so a readiness probe built on it reports healthy for a
process that has already exited. That lesson was recorded for one resource kind
and then reintroduced for two more.

If your change touches lifecycle, readiness, wake or sleep, say in the pull
request what you ran and what you saw.

## Pull requests

- One change per pull request. A refactor bundled with a fix gets reviewed as
  neither.
- Say what you ran. "Tests pass" is worth less than the command and its output.
- If you are unsure whether something is in scope, open an issue first and
  save yourself the work.
- Commits: `type(scope): subject`, lowercase, no trailing period, no em-dash.

## Security

If you find something with a security impact, do not open a public issue. Mail
business@uziiuzair.com. Studio is network-exposed by design (ADR 0008) and is
the largest surface here, so reports about it are especially wanted.

## Licence

Contributions are accepted under the Apache License 2.0, the same licence the
project ships under. There is no contributor licence agreement to sign.
