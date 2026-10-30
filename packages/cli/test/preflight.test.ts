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
import net, { type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createFakeRuntime, openStore, resolvePaths, type ComputeRuntime, type HobbyConfig, type Store } from '@hobby.sh/core'
import { ActivityTracker } from '@hobby.sh/proxy'
import { createDefaultKindRegistry, runPreflight, type DaemonContext } from '../src/index.js'
import { acquireDaemonLock } from '../src/daemon/single-instance.js'
import { hostNetworkingWarning, preflightBlockers, studioExposureNote } from '../src/cli/output.js'

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
    proxyHost: '127.0.0.1',
    proxyTls: null,
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
    project: null,
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

// --- what the daemon will bind (issue #108) --------------------------------

// A lock path of this test's own, so a daemon running on the developer's
// box never shows up in a result here.
function testLockPath(): string {
  return join(tmpdir(), `hobby-preflight-lock-${randomUUID()}`)
}

test('every port the daemon binds is checked, on the host it binds it on, and studioPort is not', async () => {
  const ctx = buildContext(createFakeRuntime())
  const report = await runPreflight(ctx, { lockPath: testLockPath() })

  for (const key of ['proxy', 'api', 'http', 'queue'] as const) {
    const check = report.ports[key]
    assert.equal(check.host, '127.0.0.1')
    assert.equal(check.bound, false, `port 0 is never in use: ${key}`)
    assert.equal(check.error, null)
  }
  assert.equal(report.ports.caddy, null, 'caddy off: 80/443 not checked')
  assert.equal('studio' in report.ports, false, 'nothing listens on studioPort, so it is not reported as a port')
  assert.deepEqual(report.proxyHost, { setting: '127.0.0.1', hosts: ['127.0.0.1'], error: null })
  assert.equal(report.studio.listen, '127.0.0.1:0')
  assert.equal(report.studio.publicHost, null)
  assert.equal(report.daemon, null)
})

test('a port something else holds is reported bound, by name', async () => {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const taken = (server.address() as AddressInfo).port
  try {
    const ctx = buildContext(createFakeRuntime(), { apiPort: taken })
    const report = await runPreflight(ctx, { lockPath: testLockPath() })
    assert.equal(report.ports.api.port, taken)
    assert.equal(report.ports.api.bound, true)
    assert.equal(report.ports.proxy.bound, false)
    assert.match(preflightBlockers(report).join('\n'), new RegExp(`api port ${taken} on 127.0.0.1 is already in use`))
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('a proxyHost this machine does not have is reported as unbindable, as the daemon would find it', async () => {
  // 198.51.100.0/24 is TEST-NET-2, reserved for documentation and never
  // routed, so no interface here carries it (the issue used 10.9.9.9).
  const ctx = buildContext(createFakeRuntime(), { proxyHost: '198.51.100.23' })
  const report = await runPreflight(ctx, { lockPath: testLockPath() })

  assert.deepEqual(report.proxyHost, { setting: '198.51.100.23', hosts: ['198.51.100.23'], error: null })
  assert.equal(report.ports.proxy.host, '198.51.100.23')
  assert.equal(report.ports.proxy.bound, false)
  assert.equal(report.ports.proxy.error, 'EADDRNOTAVAIL')
  const blockers = preflightBlockers(report)
  assert.equal(blockers.length, 1)
  assert.match(blockers[0] ?? '', /proxy port 0 cannot be bound on 198.51.100.23 \(EADDRNOTAVAIL\)/)
})

test('a proxyHost that does not resolve is reported with the lookup failure', async () => {
  const ctx = buildContext(createFakeRuntime(), { proxyHost: 'bogus.invalid' })
  const report = await runPreflight(ctx, { lockPath: testLockPath() })

  assert.equal(report.ports.proxy.host, 'bogus.invalid')
  assert.equal(report.ports.proxy.bound, false)
  assert.equal(report.ports.proxy.error, 'ENOTFOUND')
  assert.equal(preflightBlockers(report).length, 1)
})

test('a running daemon is reported from the lock, and its bound ports are not blockers when it is this process', async () => {
  const lockPath = testLockPath()
  const lock = acquireDaemonLock('/home/someone/.hobby', lockPath)
  try {
    const ctx = buildContext(createFakeRuntime())
    const report = await runPreflight(ctx, { lockPath })
    assert.ok(report.daemon !== null)
    assert.equal(report.daemon.pid, process.pid)
    assert.equal(report.daemon.running, true)
    assert.equal(report.daemon.self, true)
    assert.deepEqual(preflightBlockers(report), [])
  } finally {
    lock.release()
  }
})

test('with caddy on, 80 and 443 are checked by connecting, and studio reports its public hostname', async () => {
  const ctx = buildContext(createFakeRuntime(), { caddyEnabled: true, caddyStudioHost: 'studio.example.com' })
  const report = await runPreflight(ctx, { lockPath: testLockPath() })

  assert.ok(report.ports.caddy !== null)
  assert.deepEqual(
    report.ports.caddy.map((c) => c.port),
    [80, 443]
  )
  for (const check of report.ports.caddy) {
    assert.equal(check.host, '127.0.0.1')
    // Whatever this machine has on 80/443, the probe answers one of the two
    // honest ways; it never throws and never needs root.
    assert.equal(typeof check.bound, 'boolean')
  }
  assert.equal(report.studio.publicHost, 'studio.example.com')
  assert.match(studioExposureNote(report), /published by caddy at https:\/\/studio\.example\.com/)
  assert.match(studioExposureNote(report), /reachable from the internet/)
})
