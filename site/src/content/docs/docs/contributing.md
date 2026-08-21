---
title: Contributing
description: What is likely to be accepted, what needs a decision record first, and the two working agreements that will get a patch sent back.
---

<p class="state state--running">contributions welcome</p>

The full text lives in
[`CONTRIBUTING.md`](https://github.com/uziiuzair/hobbyist/blob/main/CONTRIBUTING.md)
in the repository. The short version:

## Two things to know first

**This is not a business, and it is one person's project.** There is no company,
no revenue, no support rota and no service level on anything, including replies.
An issue that sits unanswered is not a slight, it is one person's attention being
finite.

**Scope is the main risk, not competition.** The failure mode named at the top of
the project is a half-finished platform abandoned at 40 percent. Every feature
that gets refused is refused for that reason, not because it is a bad idea. Most
of them are good ideas. That is exactly the problem.

## Most useful right now

1. **A cold start measurement on a cheap VPS.** The project's central claim is
   written against a machine nobody has measured. File the numbers with the
   hardware stated.
2. **The Linux queue producer fix.** Add extra hosts to `ContainerSpec` and emit
   the flag, or resolve the gateway address into the URL at container start.
3. **A CLI verb for snapshots.** The daemon half is written and tested and
   reachable from nothing.

## Needs a decision record before any code

Anything in the out-of-scope list: Kubernetes, clustering, multi-node,
multi-tenancy across owners, a hosted tier, billing, metering, end-user auth as a
service, realtime subscriptions, edge execution, DNS or secrets management,
Terraform providers, Helm charts.

The list is a toll, not a wall. Write `docs/decisions/NNNN-your-case.md`, open it
as a pull request on its own, and let it be argued before you write the
implementation. [The existing records](/docs/decisions/) show the shape.

## Two agreements that will get a patch sent back

- **No em-dashes.** Anywhere. Docs, comments, commit messages, program output.
- **Ground claims in code.** Cite `path/to/file.ts` and a symbol rather than
  describing what you believe the code does.

## Run it, do not only test it

Three of the worst bugs found so far came from running a container and none from
a test suite that was passing at the time. If your change touches lifecycle,
readiness, wake or sleep, say in the pull request what you ran and what you saw.
