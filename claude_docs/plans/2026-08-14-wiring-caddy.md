# Wiring Caddy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `createCaddyManager` its first production caller, so the HTTP wake
router has a front door.

**Architecture:** Four calls added to `startDaemon`, gated on three new opt-in
flat `caddy*` config fields, with a preflight check for host networking and a failure
path that logs rather than aborting the daemon.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, `tsc --build` to
`packages/*/dist`, `npm test` from the repo root.

**Spec:** `docs/proxy/specs/2026-08-14-wiring-caddy-design.md`

**Worktree:** `.claude/worktrees/caddy-wiring`, branch `caddy-wiring`, based on
`e0d56a2`. Baseline is 508 tests.

## Global Constraints

- **NO EM-DASHES anywhere**, in code, comments, commit messages or output.
- **Narrowing, never casting.** No `as`, `!` or `any` to resolve a type error.
- **Comments cite `path/to/file.ts` with a symbol name**, and every line number
  cited must be verified against the current file.
- **`packages/core` never imports Docker, Postgres or HTTP.**
- **Two gates, both must pass before every commit:** `npm test` from the
  worktree root, AND `npm run build`. The second one is not optional: it is the
  gate that caught a Critical on the previous sub-project, because
  `packages/studio/tsconfig.test.json` excludes `.tsx` so `npm test` never
  typechecks Studio's components.
- **The compiler is not a safety net in this repo.** There is no exhaustive
  switch on `ResourceKind` or `ResourceState` anywhere, `as` casts silence
  narrowing at the wire boundary, and template literals accept `null` silently.
  Six distinct instances were found across three sessions in one day, none by
  tsc. After a clean build, grep and read.

---

### Task 1: The `caddy` config block

**Files:**
- Modify: `packages/core/src/config.ts` (`HobbyConfig`, its defaults, the env parser)
- Test: `packages/core/test/config.test.ts` if it exists, otherwise the nearest existing config test

**Interfaces:**
- Produces: three FLAT fields on `HobbyConfig`: `caddyEnabled: boolean` (false), `caddyAdminPort: number` (2019), `caddyStudioHost: string | null` (null). NOT a nested object: see Ruling F1 in the ledger.

- [ ] **Step 1: Find where config tests live and read the existing pattern**

Run: `ls packages/core/test/ && grep -rn "HOBBY_STUDIO_PORT" packages/core/test/ | head`
Do not invent a new test file if an existing one covers config parsing.

- [ ] **Step 2: Write the failing tests**

```ts
test('caddy is off by default, because starting it binds :80 and :443', () => {
  const config = defaultConfig()
  assert.equal(config.caddyEnabled, false)
  assert.equal(config.caddyAdminPort, 2019)
  assert.equal(config.caddyStudioHost, null)
})

test('the three caddy env overrides parse', () => {
  const config = configFromEnv({
    HOBBY_CADDY_ENABLED: '1',
    HOBBY_CADDY_ADMIN_PORT: '2020',
    HOBBY_CADDY_STUDIO_HOST: 'studio.example.com',
  })
  assert.equal(config.caddyEnabled, true)
  assert.equal(config.caddyAdminPort, 2020)
  assert.equal(config.caddyStudioHost, 'studio.example.com')
})
```

Match the real helper names in `config.ts`; the two above are placeholders for
whatever that file actually exports.

- [ ] **Step 3: Run to verify they fail**

Run: `npx tsc --build && node --test packages/core/dist/test/*.test.js`
Expected: FAIL at compile, `caddy` does not exist on `HobbyConfig`.

- [ ] **Step 4: Add the block**

```ts
  // The HTTP front door (ADR 0009), opt-in and off by default. Starting it
  // binds :80 and :443 on the operator's box, which is a surprising side
  // effect for a daemon restart, and packages/cli/src/daemon/caddy.ts's own
  // warnOnFirstExposure says plainly that the auth surface behind it has
  // not been reviewed against a live host. See the spec's Decision 1.
  //
  // Deliberately named `caddy` rather than `ingress`: a parallel session
  // owns the ingress-mode taxonomy (decision
  // hobbyist.ingress-two-lanes-tailscale-byo, ADR 0015 pending), and this
  // implements exactly one of its two lanes. Squatting `ingress` from here
  // would make their ADR undo a name before defining one.
  caddyEnabled: boolean
  caddyAdminPort: number
  // Null means no Studio route is published and Caddy serves only the
  // catch-all, which is correct for a box that runs apps and does not
  // want its control plane on the network.
  caddyStudioHost: string | null
```

FLAT, not a nested `caddy: {}` object, and this is correctness rather than
style. `resolveConfig` (`packages/core/src/config.ts:142-150`) merges with a
shallow spread of `DEFAULT_CONFIG`, the file config and the env config. Every
existing field is a scalar so that is correct today. A nested object would be
the only exception, and `HOBBY_CADDY_ENABLED=1` on its own would replace the
whole sub-object, leaving `adminPort` and `studioHost` `undefined` rather than
defaulted, with no type error because `readEnvConfig` returns
`Partial<HobbyConfig>`.

- [ ] **Step 5: Both gates, then commit**

Run: `npm test` and `npm run build`
Expected: 510 passing, build exits 0.

```bash
git add -A
git commit -m "feat(core): a caddy block, off by default

Starting Caddy binds :80 and :443 on the operator's box, so it is opt-in.
caddy.ts's own warnOnFirstExposure already says the auth surface behind it
has not been exercised against a live host, and defaulting it on would
contradict the warning the same file prints.

Named \`caddy\` and not \`ingress\` on purpose. A parallel session owns the
ingress-mode taxonomy and owes an ADR for it; this implements one of its two
lanes and should not take the general name on the way past."
```

---

### Task 2: Wire the four calls into `startDaemon`

**Files:**
- Modify: `packages/cli/src/daemon/server.ts` (`startDaemon`, and its shutdown path)
- Test: `packages/cli/test/caddy.test.ts` (exists; it already tests the manager against a fake `fetchFn`)

**Interfaces:**
- Consumes: Task 1's three flat caddy fields.
- Produces: no new exports. `startDaemon` gains an optional `caddy` seam in its options so tests can inject a fake manager, following the polarity of the existing `probeFactory` and `detectTailnet` seams (production wires the real one, tests leave it unset).

- [ ] **Step 1: Read the existing seams before adding one**

Run: `grep -n "probeFactory\|detectTailnet" packages/cli/src/daemon/context.ts | head`
Match that polarity exactly. Do not invent a different injection style.

- [ ] **Step 2: Write the failing tests**

```ts
test('with caddy disabled, the daemon touches neither the runtime nor the admin API', async () => {
  const { runtime, fetches } = await startWithCaddy({ enabled: false })
  assert.deepEqual(runtime.calls.filter((c) => c.includes('hobby-caddy')), [])
  assert.equal(fetches.length, 0)
})

test('with caddy enabled, ensureRunning happens before the fallback is pushed', async () => {
  const { order } = await startWithCaddy({ enabled: true, studioHost: null })
  assert.deepEqual(order, ['ensureRunning', 'setFallback'])
})

test('the fallback points at the wake router and carries the tls ask path', async () => {
  const { fallback } = await startWithCaddy({ enabled: true, studioHost: null })
  assert.equal(fallback?.upstream, '127.0.0.1:7433')
  assert.match(fallback?.askUrl ?? '', /\/\.hobby\/tls-ask/)
})

test('a studio route is published when a host is set and the studio listener is up', async () => {
  const { routes } = await startWithCaddy({ enabled: true, studioHost: 'studio.example.com' }, { apiPort: 7432 })
  assert.equal(routes[0]?.host, 'studio.example.com')
  assert.equal(routes[0]?.upstream, '127.0.0.1:7432')
})

test('no studio route when the studio listener is not started, and the skip says why', async () => {
  const { routes, stderr } = await startWithCaddy({ enabled: true, studioHost: 'studio.example.com' }, { apiPort: null })
  assert.deepEqual(routes, [])
  assert.match(stderr, /studio listener is not started/)
})

test('no studio route when no studio host is configured', async () => {
  const { routes } = await startWithCaddy({ enabled: true, studioHost: null })
  assert.deepEqual(routes, [])
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx tsc --build && node --test packages/cli/dist/test/caddy.test.js`
Expected: FAIL, `startWithCaddy` does not exist and nothing wires a manager.

- [ ] **Step 4: Wire it**

In `startDaemon`, after `startHttpRouter` and before the hibernator:

```ts
  // The front door. Nothing above this point is reachable from off the box:
  // the pg proxy is the exception and binds its own port. Caddy holds :80
  // and :443 and forwards everything it does not recognise to the wake
  // router on loopback, because Caddy cannot trigger a wake (ADR 0009).
  //
  // One fallback route, pushed once, never touched per deploy. Our router
  // already resolves the Host header to know what to wake, so a Caddy route
  // per app would be duplicated state that drifts the first time an admin
  // API call fails. See caddy.ts's own argument for this.
  const caddy = ctx.config.caddyEnabled ? (opts.caddy ?? createCaddyManager(ctx.runtime, {
    adminPort: ctx.config.caddyAdminPort,
  })) : null

  if (caddy !== null) {
    await wireCaddy(caddy, ctx, opts.apiPort)
  }
```

And a `wireCaddy` helper in the same file holding the ordering and the
skip-with-a-reason logic. Build the ask URL from the exported constant, never
from a literal:

```ts
import { TLS_ASK_PATH } from '@hobby.sh/proxy'
...
askUrl: `http://127.0.0.1:${ctx.config.httpPort}${TLS_ASK_PATH}`
```

- [ ] **Step 5: Stop it on shutdown**

In the existing close path, alongside the listener closes. Best effort: a Caddy
that will not stop must not prevent the daemon from closing its other listeners.

- [ ] **Step 6: Both gates, then commit**

Run: `npm test` and `npm run build`
Expected: 516 passing, build exits 0.

```bash
git add -A
git commit -m "feat(daemon): the wake router gets a front door

createCaddyManager has been written and tested since Phase 1 and had no
production caller, so the HTTP half of the wedge worked only if you already
knew to send a Host header to a loopback port.

Four calls: ensureRunning, one fallback route at the wake router, an optional
Studio route, and stop on shutdown. Nothing is called per deploy, which is the
point of the fallback: our router already resolves the Host header to know
what to wake, so a Caddy route per app would be state that drifts the first
time an admin push fails.

The ask URL is built from @hobby.sh/proxy's exported TLS_ASK_PATH rather than
a literal, so the two halves of on-demand TLS cannot disagree about the path."
```

---

### Task 3: Caddy failing must not take the daemon down

**Files:**
- Modify: `packages/cli/src/daemon/server.ts` (the `wireCaddy` call site)
- Test: `packages/cli/test/caddy.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

These two are the load-bearing tests of this sub-project. They encode the
difference between "the web front door is down" and "the databases are down".

```ts
test('a caddy that will not start leaves the daemon running and the pg proxy listening', async () => {
  const { daemon, stderr } = await startWithCaddy(
    { enabled: true, studioHost: null },
    { caddyFails: 'ensureRunning' }
  )
  assert.ok(daemon !== null)
  assert.match(stderr, /caddy/i)
  // The wedge: a box whose Caddy will not start still has databases that
  // must wake on connection, which has nothing to do with HTTP.
  assert.equal(await pgProxyAccepts(), true)
  await daemon.close()
})

test('a failing route push leaves the daemon running', async () => {
  const { daemon, stderr } = await startWithCaddy(
    { enabled: true, studioHost: null },
    { caddyFails: 'setFallback' }
  )
  assert.ok(daemon !== null)
  assert.match(stderr, /caddy/i)
  await daemon.close()
})
```

- [ ] **Step 2: Run to verify they fail**

Expected: FAIL, `startDaemon` rejects because the error propagates.

- [ ] **Step 3: Catch, log, continue**

```ts
  // Deliberately not fatal. A box whose Caddy will not start still has
  // Postgres resources that must wake on connection through the pg proxy,
  // which has nothing to do with HTTP. Refusing to start the daemon here
  // would take databases offline to punish a web server, inverting the
  // priority root CLAUDE.md sets. Loud, not silent, and not fatal.
  try {
    await wireCaddy(caddy, ctx, opts.apiPort)
  } catch (err) {
    console.error(
      `caddy: the front door did not come up, so apps are reachable only on their loopback ports: ${errorMessage(err)}`
    )
  }
```

- [ ] **Step 4: Both gates, then commit**

Expected: 518 passing, build exits 0.

```bash
git add -A
git commit -m "fix(daemon): a front door that will not open does not close the building

Caddy failing to start, or failing to accept a route, now logs and leaves the
daemon running. A box whose Caddy is down still has databases that must wake
on connection through the pg proxy, which has nothing to do with HTTP.
Aborting startup here would take Postgres offline to punish a web server.

Loud, not silent: the error names the admin API and says what the operator
has lost, which is the front door and not their data."
```

---

### Task 4: Detect a runtime with no host networking, at `hobby init`

**Files:**
- Modify: `packages/cli/src/daemon/preflight.ts`
- Test: `packages/cli/test/` whichever file covers preflight

**Interfaces:**
- Consumes: Task 1's `config.caddyEnabled`.
- Produces: one more entry in the preflight report.

- [ ] **Step 1: Read what a preflight entry looks like**

Run: `grep -n "runPreflight" -A 30 packages/cli/src/daemon/preflight.ts | head -40`
Follow the existing report shape exactly. Do not invent a second one.

- [ ] **Step 2: Write the failing tests**

```ts
test('the host networking check is skipped entirely when caddy is off', async () => {
  const report = await runPreflight(ctxWith({ caddyEnabled: false }))
  assert.equal(report.checks.find((c) => c.name === 'host-networking'), undefined)
})

test('a runtime without host networking warns rather than failing', async () => {
  const report = await runPreflight(ctxWith({ caddyEnabled: true }, { hostNetworking: false }))
  const check = report.checks.find((c) => c.name === 'host-networking')
  assert.equal(check?.level, 'warn')
  assert.match(check?.detail ?? '', /Docker Desktop/)
})
```

- [ ] **Step 3: Add the check**

Warning, never failure. Root `CLAUDE.md` says exactly this about the ext4
reflink case: "detect it at `hobby init`, warn rather than fail." The message
must name the known-bad case and the known-good ones, since "host networking
unavailable" alone sends people to the wrong search:

```
caddy: this container runtime does not appear to support host networking, which
Caddy needs in order to bind :80 and :443 and reach the daemon. Docker Desktop
for macOS is the known case. Linux and OrbStack both work. Hobbyist will start
without a front door: apps are reachable on their loopback ports and `hobby
studio` still works.
```

- [ ] **Step 4: Both gates, then commit**

Expected: 520 passing, build exits 0.

```bash
git add -A
git commit -m "feat(init): say so at init when the runtime cannot host-network

Caddy needs host networking to bind :80 and :443 and to reach the daemon's
loopback listeners. Docker Desktop for macOS is the known case that cannot;
Linux and OrbStack both can, the latter measured on 2026-08-14 rather than
assumed.

A warning, not a failure, matching what root CLAUDE.md already prescribes for
the ext4 reflink case. The message names the known-bad runtime and the
known-good ones, because \"host networking unavailable\" on its own sends
people looking in the wrong place."
```

---

### Task 5: `hobby studio` prints the URL that works, and the docs stop lying

**Files:**
- Modify: `packages/cli/src/cli/commands.ts` (`cmdStudio`)
- Modify: `claude_docs/ACTIVE_CONTEXT.md`, `claude_docs/PROGRESS.md`, `docs/proxy/CLAUDE.md`
- Test: `packages/cli/test/commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test('hobby studio prints the public URL when caddy is fronting it', async () => {
  const c = fakeContext({ caddyEnabled: true, caddyStudioHost: 'studio.example.com' })
  await cmdStudio(c, [])
  assert.match(c.io.stdout, /https:\/\/studio\.example\.com/)
})

test('hobby studio prints the loopback URL when caddy is off', async () => {
  const c = fakeContext({ caddyEnabled: false, caddyStudioHost: null })
  await cmdStudio(c, [])
  assert.match(c.io.stdout, /127\.0\.0\.1:/)
})
```

- [ ] **Step 2: Implement, then correct the docs**

`claude_docs/ACTIVE_CONTEXT.md` currently lists wiring Caddy as an open next
step and repeats the untested "breaks on the author's own machine" claim.
Correct both. `PROGRESS.md` gets a new top entry recording what shipped and, more
importantly, that a recorded blocker survived four days without anyone running
the one command that disproves it.

- [ ] **Step 3: Both gates, then commit**

Expected: 522 passing, build exits 0.

```bash
git add -A
git commit -m "docs: the front door is wired, and a blocker that was never true

hobby studio now prints the URL that actually works from elsewhere when Caddy
is fronting it.

ACTIVE_CONTEXT.md listed wiring Caddy as blocked on host networking being
absent on the author's machine. The author runs OrbStack, where it works in
both directions, measured. The claim was written from an assumption about
Docker Desktop and held up a sub-project for four days. Recorded in PROGRESS
because the cost of an untested claim in a context file is the interesting
part, not the wiring."
```

---

## Self-Review

**Spec coverage.** Decision 1 is Task 1, Decisions 2 and 3 are Tasks 1 and 2,
Decision 4 is Task 4, Decision 5 is Task 3, the surfaces section is Task 5. The
two known gaps (certificate persistence, Docker Desktop unmeasured) are stated in
the spec and deliberately not implemented.

**Test count.** 508 baseline, plus 2 + 6 + 2 + 2 + 2 = 14, giving 522.

**The riskiest task is 2, not 3.** Task 2 touches `startDaemon`, which every
other listener starts from, and a mistake there breaks the daemon for everyone
rather than just breaking Caddy. Its tests must assert that a disabled Caddy
makes no runtime call and no fetch at all, which is the regression that would
otherwise go unnoticed by anyone not running Caddy.
