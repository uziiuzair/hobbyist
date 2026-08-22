# Cold start fixtures

Four apps, in increasing order of how much they do before they can answer a
request. They exist because the published app wake figure was measured against
a busybox static server, which is the lightest case that exists, and a claim
about whether a real app times out cannot be answered with it.

| Fixture | What it is | Boots |
|---|---|---|
| `static` | busybox httpd serving one file | nothing |
| `express` | Node 22 and Express 5 | a Node runtime and a small dependency tree |
| `nextjs` | Next.js 15 standalone, App Router, a dynamic page | a Node runtime and the React server runtime |
| `nextjs-db` | the same, plus a Postgres query per request | the above, and it cannot answer until a database wakes too |

`nextjs` uses `output: 'standalone'`, which is what a real deployment uses, and
its page is `force-dynamic` so the measurement is of Next.js serving a request
rather than of the filesystem serving a prerendered file.

`nextjs-db` opens a fresh client per request rather than a pool, because a pool
established at module load would connect while the container was starting and
hide the cost this fixture exists to measure.

Measure them with `scripts/measure-cold-start.sh`, which takes `FIXTURE=<name>`.
