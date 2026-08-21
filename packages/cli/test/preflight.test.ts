// Written and RUN: everything here is a fake runtime, an in-memory store,
// and loopback probes (isPortBound, the reflink probe, the host-networking
// probe below), so nothing needs Docker or a real container runtime.
//
// The host-networking probe under a fake runtime is worth calling out
// specifically: createFakeRuntime (packages/core/src/runtime.ts) has no way
// to simulate a real container actually answering on a real port, on
// purpose (see preflight.ts's own comment on why this task did not add one
// to ComputeRuntime). That means under any fake runtime, in this test file
// or anywhere else, the probe can only ever observe "nothing answered" and
// report unsupported: there is no way, short of a real container runtime,
// to exercise the "supported: true" path. That is the honest limit of what
// this test file can prove, and it is written down here rather than implied.

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, type ComputeRuntime, type HobbyConfig, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, runPreflight, type DaemonContext } from '../src/index.js'
import { hostNetworkingWarning } from '../src/cli/output.js'

// Mirrors routes.test.ts's and caddy.test.ts's own testConfig/buildContext
// exactly, since that is this repo's one established way to build a
// DaemonContext for a daemon-level test. Every port is 0 (ephemeral):
// runPreflight itself binds real loopback sockets to answer "is this port
// already bound" (isPortBound), and a fixed literal here would be exactly
// the kind of test-side real-socket bind the brief asks to avoid.
function testConfig(overrides: Partial<HobbyConfig> = {}): HobbyConfig {
  return {
    image: 'postgres:18-alpine',
    proxyPort: 0,
    studioPort: 0,
    apiPort: 0,
    httpPort: 0,
    domain: 'localhost',
    sleepAfterSeconds: 300,
    wakeTimeoutMs: 150,
    readinessPollMs: 20,
    queuePort: 0,
    caddyEnabled: false,
    caddyAdminPort: 0,
    caddyStudioHost: null,
    ...overrides,
  }
}

function buildContext(runtime: ComputeRuntime, configOverrides: Partial<HobbyConfig> = {}): DaemonContext {
  const store: Store = openStore(':memory:')
  const paths = resolvePaths({ HOBBY_HOME: join(tmpdir(), `hobby-cli-test-${randomUUID()}`) })
  return {
    store,
    runtime,
    paths,
    config: testConfig(configOverrides),
    activity: new ActivityTracker(),
    kinds: createDefaultKindRegistry(),
  }
}

test('the host networking check is skipped entirely when caddy is off', async () => {
  const runtime = createFakeRuntime()
  const ctx = buildContext(runtime, { caddyEnabled: false })

  const report = await runPreflight(ctx)

  assert.equal(report.hostNetworking, null)
  // Not merely "the field is null": the runtime must never have been asked
  // to create or start anything for this check. _state and _specs are the
  // fake's own record of every container it was asked to create; both stay
  // empty when the probe never runs.
  assert.equal(runtime._state.size, 0)
  assert.equal(runtime._specs.size, 0)
})

test('a runtime without host networking warns rather than failing', async () => {
  const runtime = createFakeRuntime()
  const ctx = buildContext(runtime, { caddyEnabled: true })

  const report = await runPreflight(ctx)

  // createFakeRuntime has nothing real listening on any port it "starts",
  // so it can only ever report the runtime as unable to reach a loopback
  // listener through it: exactly the signal a real Docker Desktop for
  // macOS box would also produce.
  assert.deepEqual(report.hostNetworking, { supported: false })

  const warning = hostNetworkingWarning(report)
  assert.notEqual(warning, null)
  assert.match(warning ?? '', /Docker Desktop/)
  assert.match(warning ?? '', /OrbStack/)

  // The check still only ever warns: nothing about a report with
  // hostNetworking.supported === false makes runPreflight itself throw or
  // return a failing shape. cmdInit is what turns this into a non-fatal
  // io.err line (packages/cli/src/cli/commands.ts), matching the ext4
  // reflink case's "warn rather than fail".
  assert.equal(report.runtimeAvailable, true)
})
