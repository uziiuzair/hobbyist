# Launch prep: README, hobbyist.sh, and the install path

Written 2026-08-21. Covers the public face of the project: a README, a static
site at `hobbyist.sh`, a documentation tree, a comparison and pricing page, and
the one-liner at `hobby.sh/install`.

Nothing here changes the daemon, the CLI, or any package under `packages/`. The
one exception is that the site reads `docs/decisions/` at build time, which
makes those files load bearing for a second consumer.

## Why now

The repository has 66 test files, four resource kinds, sixteen ADRs and 61
filed documents, and a `README.md` that is zero bytes. `install.sh` at the repo
root already documents a bootstrap script at `https://hobby.sh/install` that
does not exist. Two owned domains point at nothing. The project is buildable
from a clone and undiscoverable from anywhere else.

This is a v0-alpha launch, not a 1.0. The goal is that someone who reads the
site can decide, correctly, whether to run it, and can tell which half is safe.

## The audience, in the author's words

> With the rise of AI, came a lot of new AI hobbyists, people who build stuff
> for themselves. Hobby is for them. Deploy it on your local server. Mine runs
> on my home server, accessible through Tailscale and CF Tunnel, and hosts
> Arlo's demo environments.

That is the story the landing page tells. Not "self-hosted Postgres" as a
category, but a person who now builds more than they used to and does not want
a bill for each experiment.

## Constraints inherited from the project

- **No em-dashes** anywhere, including in generated site copy.
- **Ground claims in code.** Every capability claim on the site cites a file.
  Every measured number cites the machine it was measured on.
- **Mark what is not real yet.** A reader must never execute an aspiration.
  This is the constraint the whole launch turns on.
- **Not a business.** No pricing page for Hobbyist itself, no waitlist, no
  email capture, no analytics that identify anyone.

## Architecture

```
  hobby.sh                          hobbyist.sh
      |                                  |
      | curl -fsSL https://hobby.sh/install
      v                                  v
  Cloudflare Worker              GitHub Pages
  serves bootstrap.sh            Astro + Starlight, static
  301s everything else                   |
      |                                  |
      v                        built from site/ by CI on push to main
  bootstrap.sh                           |
  clone or pull                          v
      |                        docs/decisions/*.md synced at prebuild
      v
  install.sh (already exists, unchanged)
```

Two hosts because GitHub Pages binds one custom domain per repository, and
`hobbyist.sh` is the one worth spending it on. The Worker is 30 lines and
exists so that a `curl | bash` never redirects to a third party host.

## Deliverables

### 1. `LICENSE`

Apache 2.0. Chosen over MIT because the root `CLAUDE.md` states that the
warranty disclaimer is load bearing rather than a throwaway, and Apache 2.0
carries an explicit limitation of liability alongside its patent grant. It is
also the licence of Xata, the closest prior art the project cites.

### 2. `README.md`

Sections, in order:

1. Name, one-liner, and a v0-alpha notice that names Postgres as the reliable
   part.
2. The install one-liner.
3. What this is: the convenience layer argument, three short paragraphs.
4. The wedge, with measured cold start numbers and the machines they came from,
   including the fact that a five dollar VPS has never been measured.
5. Quickstart, using only verbs that exist in
   `packages/cli/src/cli/main.ts`'s dispatch.
6. What is in the box: a table of the four kinds plus Studio, MCP and
   snapshots, each with a status.
7. Status: what works, what is rough, what is known broken, each linking to the
   file that records it.
8. Requirements.
9. Architecture, the diagram from `CLAUDE.md`.
10. Leaving: `hobby eject`.
11. Not a business, licence, no warranty.
12. Contributing, and links to the site.

### 3. `bootstrap.sh`

The half that `hobby.sh/install` serves. Its only job is to put a checkout on
disk and hand off. It must:

- Refuse anything that is not Linux or macOS, with the same wording
  `install.sh` uses, so the two failures read as one product.
- Clone to `${HOBBY_SRC:-$HOME/.hobby/src}`, or `git pull` if that path is
  already a checkout of this repository, since re-running is how you upgrade.
- Accept `HOBBY_REF` to install a tag or branch rather than `main`.
- Exec `install.sh` from the checkout, never reimplement any of its steps.

A manual `git clone && ./install.sh` must remain the identical install. That is
already promised in `install.sh`'s header comment and this script must not
break it.

### 4. `site/`, an Astro project

Astro with the Starlight integration. Starlight owns `/docs/*` and gives search,
sidebar, dark mode and prev/next without hand rolling them. Two bespoke pages
sit outside it:

- `src/pages/index.astro`, the story landing.
- `src/pages/compare.astro`, parity and pricing.

Astro file based routes take precedence over Starlight's content collection
routes, so a custom `index.astro` replaces Starlight's own landing without
fighting the theme.

`site/scripts/sync-adrs.mjs` runs before the build. It reads `docs/decisions/*.md`,
derives a title from each file's first heading, writes them into
`src/content/docs/docs/decisions/` with Starlight frontmatter, and writes an
index. CI runs the same script and fails if the result differs from what is
committed, so an ADR cannot silently drift from its rendered copy.

The visual direction reuses the Studio's tokens (`packages/studio/src/theme.css`,
`packages/studio/DESIGN.md`) so the site and the product look like one thing.

### 5. Landing page beats

1. **Hook.** The author's excerpt, near verbatim.
2. **The problem.** Every primitive under a managed platform is free and mature.
   The convenience is what people pay for, and it is the only thing missing from
   the self-hosted world.
3. **The wedge.** Everything sleeps, everything wakes on demand. Stated against
   the three named alternatives: self-hosted Supabase never sleeps, Xata's
   open-source plugin cannot wake, Coolify and Dokploy do not sleep.
4. **The numbers.** Postgres 170 to 186ms p50/p95 measured 2026-08-07. HTTP app
   p50 121ms, p95 133ms. Worker p50 299ms, p95 321ms, both measured 2026-08-10
   on an Apple M5 Pro. Budget is 1s target, 3s hard ceiling. The five dollar VPS
   is unmeasured and the page says so in the same breath as the good numbers.
5. **The demo.** Install, `hobby new blog`, a connection string, walk away, come
   back, connect and it wakes.
6. **Status.** v0-alpha. Per-feature labels. Named gaps, each linked.
7. **Not a business.** No cloud, no paid tier, no billing, no warranty.
   Contributions welcome. Closing line: your stack, your box, their convenience.

### 6. Documentation tree

```
Start here    what Hobbyist is · install · your first project · alpha status
Concepts      projects and resources · sleep and wake · daemon, proxy and Caddy ·
              the data directory and why you can leave
Guides        postgres · apps · workers · durable objects · queues · studio ·
              snapshots and restore · eject and adopt · tailscale and tunnels
Reference     CLI · daemon HTTP API · MCP tools · configuration and paths ·
              filesystem requirements
Decisions     ADRs 0001 to 0016, synced from docs/decisions/
Contributing
```

Durable Objects get a guide but not a kind entry: `packages/core/src/types.ts:13`
defines `ResourceKind` as `'postgres' | 'app' | 'worker' | 'queue'`, and Durable
Objects are a capability of `worker`. The docs must not invent a fifth kind.

Every guide page opens with a status line drawn from a fixed vocabulary:
`reliable`, `works, rough edges`, `known broken`, `not built yet`.

The CLI reference is hand written but checked in CI: a script asserts that every
verb `printHelp` (`packages/cli/src/cli/main.ts:120`) prints has a reference
entry, and that the reference invents none. Generating the page from `printHelp`
outright would mean refactoring the CLI to expose its help table, which is out
of scope for a documentation launch.

### 7. Comparison

Rows: Postgres, branching, scale to zero, wake on connect, dashboard, HTTP apps,
workers, Durable Objects, queues, object storage, backups, point in time
recovery, custom domains and TLS, MCP, multi-region, auth as a service,
realtime, self-host, eject.

Columns: Hobbyist, Cloudflare, Neon, Supabase, Fly.io.

Values are yes, partial, no, or out of scope. Rows the project loses stay in the
table and say so: multi-region, PITR (cut deliberately, ADR 0016), auth as a
service and realtime (both out of scope per `CLAUDE.md`). A comparison that only
lists wins is an advertisement, and the project has nothing to sell.

Every Hobbyist cell footnotes the file that backs it.

### 8. Pricing

Four hardware bases, every figure fetched at build authoring time and stamped
with the date checked:

| Basis | Quoted as |
|---|---|
| Home server | Mac Mini, an old laptop, a Pi. Hardware amortised over 3 years plus electricity at a stated rate |
| Cheap VPS | The 5 to 6 dollar tier the cold start budget is written against |
| Hetzner | A CX-line VPS and an AX-line dedicated box |
| Mid dedicated | Roughly 50 to 100 a month |

Against those, the four platforms at free tier and first paid tier, plus one
worked scenario: ten small projects, mostly idle, which is the case sleep exists
for. Domain registration quoted from Namecheap.

Assumptions are printed inline next to the numbers, not in a footnote. The
comparison is only honest if the reader can see what was assumed.

### 9. `worker/`, the hobby.sh Worker

`GET /install` returns `bootstrap.sh` as `text/x-shellscript` with a short cache
lifetime. Everything else 301s to `hobbyist.sh`. The script is bundled at deploy
time from the repository copy, so there is one script and not two.

### 10. CI

- `.github/workflows/pages.yml`: on push to `main` touching `site/`, `docs/` or
  `README.md`, run the ADR sync, build the site, deploy to GitHub Pages.
- `.github/workflows/ci.yml`: on pull request, `npm run typecheck` and
  `npm test`. Required once the README says contributions are welcome, because
  the alternative is reviewing every contribution by hand on a project whose
  stated failure mode is the author's attention running out.

### 11. `scripts/launch-setup.sh`

One script, run by hand after review. Creates the DNS records on both zones via
the Cloudflare API, deploys the Worker with wrangler, and prints what to verify
and in what order. It reads `CLOUDFLARE_API_TOKEN` from the environment, prints
every change before making it, and is safe to re-run.

It does not run itself, and nothing else in this spec touches a live zone.

## What this deliberately does not do

- **No blog, no changelog, no roadmap page.** A roadmap is a promise, and the
  project's stated failure mode is abandonment at 40 percent.
- **No analytics, no email capture, no waitlist.** Nobody is being sold
  anything.
- **No `hobby.sh` landing page.** It 301s. One site.
- **No screenshots of Studio on the landing page** until Studio's status is
  better than it is. A screenshot is a promise that the thing behind it works.
- **No versioned documentation.** There is one version, `main`, and pretending
  otherwise is upkeep bought with nothing.

## Risks

- **The site can drift from the code.** Mitigated for ADRs and the CLI help text
  by CI checks. Not mitigated for prose in guides, which is a standing cost.
- **Prices go stale.** Every figure carries the date it was checked, so a stale
  number reads as stale rather than as wrong.
- **A launch invites issues, and issue volume is attention.** The root
  `CLAUDE.md` names attention as the scarce resource. `CONTRIBUTING.md` should
  set expectations plainly: this is one person's project, there is no SLA on
  replies, and an unanswered issue is not a slight.

## Success criteria

1. `curl -fsSL https://hobby.sh/install | bash` installs on a fresh Ubuntu box.
2. A reader can tell, without reading the source, which parts are safe to use.
3. Nothing on the site describes a capability that does not run.
4. `hobbyist.sh` builds from a clone with `npm install && npm run build` inside
   `site/` and needs no secret to do it.
