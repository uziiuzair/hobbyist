#!/usr/bin/env node
// A live end to end smoke test against real Docker.
//
//   node scripts/smoke.mjs
//
// It builds the workspace, starts a real `hobby daemon` under a throwaway
// HOBBY_HOME on non-default ports, drives it through the shipped CLI and real
// clients (psql, HTTP through the wake router, a worker calling send() from
// inside its container), prints PASS or FAIL per scenario, and always tears
// down what it made. It exits non-zero if any scenario failed.
//
// Why it exists: the unit suite runs against a fake ComputeRuntime on purpose
// (ci.yml, the `workspace` job), so until this ran nothing in CI had ever
// touched Docker, and every Linux claim in the issue tracker (#14 above all)
// waited on someone with a Linux box. The GitHub runner is that box.
//
// Node rather than shell because the only shell alternative needs GNU date for
// millisecond timings (scripts/measure-cold-start.sh says so) and jq or python
// for JSON, and this has to run unchanged on macOS. Plain Node, no
// dependencies, so it runs before or without anything in node_modules.
//
// Environment, all optional:
//
//   SMOKE_SKIP_BUILD=1        reuse the compiled packages/*/dist as they are
//   SMOKE_ARTIFACTS=<dir>     where the daemon log, container logs and the
//                             summary go. Default: a directory under /tmp,
//                             removed on success and kept on failure
//   SMOKE_KEEP=1              leave the daemon, projects and HOBBY_HOME up for
//                             inspection instead of tearing down
//   SMOKE_PORT_BASE=<n>       daemon ports are <n>+0..3 (default 27430: proxy
//                             27430, api 27431, http 27432, queue 27433)
//   SMOKE_SLEEP_AFTER=<s>     idle threshold new projects are born with
//                             (HOBBY_SLEEP_AFTER_SECONDS), default 10
//
// What it deliberately does not do:
//
// - It does not stop, signal or share a daemon that is already running. The
//   daemon lock is machine-wide (/tmp/hobby-daemon.lock, single-instance.ts),
//   and a live holder makes this refuse to start rather than contend with it.
// - It does not enable Caddy. HOBBY_CADDY_ENABLED=false, and apps and workers
//   are reached through the HTTP wake router with a Host header, the way
//   scripts/measure-cold-start.sh does. Caddy fronts that same router, so the
//   wake path is fully exercised; Caddy itself (host networking, ports 80 and
//   443, TLS issuance) is not, and nothing here claims it is.
// - It never prints a connection string or the ejected compose file, both of
//   which carry the throwaway database passwords this run generates.

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOBBY_BIN = join(REPO, 'packages/cli/bin/hobby.js')
const FIXTURES = join(REPO, 'scripts/smoke-fixtures')
const LOCK_PATH = '/tmp/hobby-daemon.lock'

const RUN_ID = randomBytes(3).toString('hex')
// Every name this run creates starts with this, and teardown's safety net
// removes only Docker objects whose names start with `hobby-<prefix>` or
// `hobby/<prefix>`. That is what keeps it from touching anything else on a
// developer's machine. Names must match ^[a-z][a-z0-9-]{1,62}$ (core/names.ts).
const PREFIX = `smk${RUN_ID}`
const DB_PROJECT = `${PREFIX}db`
const BRANCH_PROJECT = `${PREFIX}db-br`
const RESTORE_PROJECT = `${PREFIX}db-rs`
const COMPUTE_PROJECT = `${PREFIX}c`
const ALL_PROJECTS = [COMPUTE_PROJECT, RESTORE_PROJECT, BRANCH_PROJECT, DB_PROJECT]

const PORT_BASE = Number(process.env.SMOKE_PORT_BASE ?? 27430)
const PORTS = { proxy: PORT_BASE, api: PORT_BASE + 1, http: PORT_BASE + 2, queue: PORT_BASE + 3 }
const SLEEP_AFTER = Number(process.env.SMOKE_SLEEP_AFTER ?? 10)
// The hibernator ticks every 10 seconds (HIBERNATION_TICK_MS, server.ts), so a
// resource idle past its threshold is asleep within threshold + one tick. The
// rest is slack for a loaded CI runner.
const SLEEP_WAIT_MS = (SLEEP_AFTER + 10 + 40) * 1000

// Short and literally under /tmp: macOS caps a unix socket path at 104 bytes,
// and $HOBBY_HOME/hobby.sock under os.tmpdir() (/var/folders/...) or a deep
// scratch directory fails listen() with EINVAL
// (docs/queues/research/2026-08-14-queues-survive-sleep.md, deviation 3).
const RUN_DIR = mkdtempSync(`/tmp/hsmk-${RUN_ID}-`)
const HOBBY_HOME = join(RUN_DIR, 'home')
const WORK_DIR = join(RUN_DIR, 'work')
const ARTIFACTS = resolve(process.env.SMOKE_ARTIFACTS ?? join('/tmp', `hobby-smoke-${RUN_ID}-artifacts`))
const DAEMON_LOG = join(ARTIFACTS, 'daemon.log')
mkdirSync(WORK_DIR, { recursive: true })
mkdirSync(ARTIFACTS, { recursive: true })

const HOBBY_ENV = {
  ...process.env,
  HOBBY_HOME,
  HOBBY_PROXY_PORT: String(PORTS.proxy),
  HOBBY_API_PORT: String(PORTS.api),
  HOBBY_HTTP_PORT: String(PORTS.http),
  HOBBY_QUEUE_PORT: String(PORTS.queue),
  HOBBY_CADDY_ENABLED: 'false',
  HOBBY_SLEEP_AFTER_SECONDS: String(SLEEP_AFTER),
  // Generous: the first wake of a fresh project on a cold CI runner can pull
  // nothing but still pays for a first container start on a cold disk.
  HOBBY_WAKE_TIMEOUT_MS: '60000',
}
// A developer's own remote (`hobby login`, remote.ts) must not redirect the
// CLI away from this run's daemon. The CLI also walks up from its cwd for a
// hobby.json (config.ts, findConfigFile), which is why every command runs from
// WORK_DIR under /tmp rather than from the checkout.
delete HOBBY_ENV.HOBBY_REMOTE

// ---------------------------------------------------------------------------
// Output

const SUMMARY_LOG = join(ARTIFACTS, 'summary.txt')
function say(line = '') {
  process.stdout.write(`${line}\n`)
  appendFileSync(SUMMARY_LOG, `${line}\n`)
}

// Anything that might carry a credential is passed through this before it is
// printed or written to the failure artifacts: postgres URLs, PASSWORD, TOKEN
// and SECRET assignments, and JSON keys ending in token, secret or password,
// including the escaped JSON inside a worker's HOBBY_WORKER_MANIFEST env var
// (its queueToken reached a CI artifact on the first Linux run).
function redact(text) {
  return String(text)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, '$1***@')
    .replace(/((?:PASSWORD|TOKEN|SECRET)[^:=\n"]*[:=]\s*)[^\s"\\]+/gi, '$1***')
    .replace(/((?:token|secret|password)\\*"\s*:\s*\\*")[^"\\]+/gi, '$1***')
}

function since(start) {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`
}

// ---------------------------------------------------------------------------
// Processes

// Runs a command to completion. Never throws on a non-zero exit: callers
// decide, because several scenarios want the stderr of a failure in the
// report rather than an exception.
function run(cmd, args, { env = HOBBY_ENV, cwd = WORK_DIR, timeoutMs = 120_000, input } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolvePromise({ code: 127, stdout, stderr: `${stderr}${err.message}`, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: timedOut ? 124 : code, stdout, stderr, timedOut })
    })
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

function hobby(args, opts = {}) {
  return run(process.execPath, [HOBBY_BIN, ...args], opts)
}

function failure(what, res) {
  const tail = `${res.stderr}\n${res.stdout}`.trim().split('\n').slice(-12).join('\n')
  return new Error(`${what} exited ${res.code}${res.timedOut ? ' (timed out)' : ''}:\n${redact(tail)}`)
}

async function hobbyOk(args, opts = {}) {
  const res = await hobby(args, opts)
  if (res.code !== 0) throw failure(`hobby ${args.join(' ')}`, res)
  return res
}

async function hobbyJson(args, opts = {}) {
  const res = await hobbyOk([...args, '--json'], opts)
  try {
    return JSON.parse(res.stdout)
  } catch {
    throw new Error(`hobby ${args.join(' ')} --json did not print JSON: ${redact(res.stdout.slice(0, 300))}`)
  }
}

async function psql(connectionString, sql) {
  const res = await run('psql', [connectionString, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    env: { ...process.env, PGCONNECT_TIMEOUT: '60' },
    timeoutMs: 90_000,
  })
  if (res.code !== 0) throw failure('psql', res)
  return res.stdout.trim()
}

// One HTTP GET through the wake router. The router routes on the Host header
// alone (packages/proxy/src/http.ts), so this needs no DNS for *.localhost
// and no Caddy, the same as scripts/measure-cold-start.sh.
function httpGet(host, path, timeoutMs = 90_000) {
  return new Promise((resolvePromise, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORTS.http, path, method: 'GET', headers: { host }, timeout: timeoutMs },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (body += d))
        res.on('end', () => resolvePromise({ status: res.statusCode, body }))
      }
    )
    req.on('timeout', () => req.destroy(new Error(`GET ${host}${path} timed out after ${timeoutMs}ms`)))
    req.on('error', reject)
    req.end()
  })
}

async function waitFor(what, timeoutMs, fn, intervalMs = 1000) {
  const start = Date.now()
  let last
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${since(start)} waiting for ${what}`)
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

// ---------------------------------------------------------------------------
// Daemon state

async function listing() {
  return hobbyJson(['ls'])
}

async function resource(project, name) {
  const all = await listing()
  const entry = all.find((d) => d.project.name === project)
  return entry?.resources.find((r) => r.name === name) ?? null
}

async function stateOf(project, name) {
  return (await resource(project, name))?.state ?? 'missing'
}

async function waitState(project, name, want, timeoutMs) {
  let seen = 'unknown'
  try {
    await waitFor(`${project}/${name} to be ${want}`, timeoutMs, async () => {
      seen = await stateOf(project, name)
      return seen === want
    })
  } catch (err) {
    throw new Error(`${err.message} (last state: ${seen})`)
  }
}

async function connectionString(project) {
  const out = await hobbyJson(['connect', project])
  if (!out.connectionString) throw new Error(`hobby connect ${project} --json had no connectionString`)
  return out.connectionString
}

// ---------------------------------------------------------------------------
// Scenarios

const results = []
const facts = {}

async function scenario(name, fn, { needs = [] } = {}) {
  const blocked = needs.filter((n) => results.find((r) => r.name === n)?.status !== 'PASS')
  if (blocked.length > 0) {
    results.push({ name, status: 'SKIP', detail: `needs ${blocked.join(', ')}` })
    say(`SKIP  ${name}  (needs ${blocked.join(', ')})`)
    return
  }
  say(`----  ${name}`)
  const start = Date.now()
  try {
    const detail = (await fn()) ?? ''
    results.push({ name, status: 'PASS', detail, took: since(start) })
    say(`PASS  ${name}  ${since(start)}${detail ? `  ${detail}` : ''}`)
  } catch (err) {
    const detail = redact(err?.message ?? String(err))
    results.push({ name, status: 'FAIL', detail, took: since(start) })
    say(`FAIL  ${name}  ${since(start)}`)
    for (const line of detail.split('\n')) say(`      ${line}`)
    // Now, not at the end: the rm scenario and teardown remove the containers
    // whose logs explain this failure.
    try {
      await collectLogs()
    } catch (logErr) {
      say(`      collecting logs failed: ${logErr.message}`)
    }
  }
}

let daemon = null

async function startDaemon() {
  const out = openSync(DAEMON_LOG, 'a')
  daemon = spawn(process.execPath, [HOBBY_BIN, 'daemon'], {
    env: HOBBY_ENV,
    cwd: WORK_DIR,
    stdio: ['ignore', out, out],
  })
  let exited = null
  daemon.on('exit', (code, signal) => (exited = { code, signal }))
  await waitFor('the daemon to answer `hobby ls`', 60_000, async () => {
    if (exited) {
      throw new Error(
        `the daemon exited (${exited.code ?? exited.signal}) before answering. Its log:\n` +
          readFileSync(DAEMON_LOG, 'utf8').trim().split('\n').slice(-15).join('\n')
      )
    }
    return (await hobby(['ls', '--json'], { timeoutMs: 10_000 })).code === 0
  }, 500)
  return `pid ${daemon.pid}, HOBBY_HOME ${HOBBY_HOME}`
}

const scenarios = [
  ['host preflight (hobby init)', async () => {
    const res = await hobby(['init'], { timeoutMs: 60_000 })
    appendFileSync(join(ARTIFACTS, 'init.txt'), `${res.stdout}\n${res.stderr}`)
    if (res.code !== 0) throw failure('hobby init', res)
    const fs = res.stdout.split('\n').find((l) => l.startsWith('filesystem')) ?? ''
    return fs.replace(/^filesystem \([^)]*\): /, 'filesystem: ')
  }],

  ['daemon starts', startDaemon, { needs: ['host preflight (hobby init)'] }],

  ['postgres: create and query through the proxy', async () => {
    await hobbyOk(['new', DB_PROJECT], { timeoutMs: 300_000 })
    const conn = await connectionString(DB_PROJECT)
    const start = Date.now()
    const got = await psql(
      conn,
      "create table smoke(marker text); insert into smoke values ('smoke-marker-42'); select marker from smoke"
    )
    if (got !== 'smoke-marker-42') throw new Error(`expected smoke-marker-42, got ${JSON.stringify(got)}`)
    facts.dbIdleSince = Date.now()
    return `first query, including its wake, ${since(start)}`
  }, { needs: ['daemon starts'] }],

  // Deploys come before the sleep check on purpose: the builds take minutes on
  // a CI runner, and the database's idle clock runs out meanwhile, so the wait
  // for the hibernator costs nothing extra.
  ['app: deploy', async () => {
    await hobbyOk(['new', COMPUTE_PROJECT, '--empty'])
    await hobbyOk(['deploy', join(FIXTURES, 'app'), '--project', COMPUTE_PROJECT, '--name', 'web', '--port', '8080'], {
      timeoutMs: 600_000,
    })
    const r = await resource(COMPUTE_PROJECT, 'web')
    facts.appHost = r?.config?.hostname
    if (!facts.appHost) throw new Error('hobby ls --json shows no hostname for the app')
    return `reachable as ${facts.appHost}`
  }, { needs: ['daemon starts'] }],

  ['workers: deploy a consumer and a producer', async () => {
    // Consumer first, so the queue has a consumer bound by the time anything
    // produces to it.
    for (const name of ['consumer', 'producer']) {
      await hobbyOk(['deploy', join(FIXTURES, name), '--project', COMPUTE_PROJECT, '--name', name], {
        timeoutMs: 600_000,
      })
    }
    const p = await resource(COMPUTE_PROJECT, 'producer')
    facts.producerHost = p?.config?.hostname
    if (!facts.producerHost) throw new Error('hobby ls --json shows no hostname for the producer')
    const q = await resource(COMPUTE_PROJECT, 'smoke-jobs')
    if (!q) throw new Error('deploying the workers did not create the smoke-jobs queue')
    return `queue smoke-jobs is ${q.state}`
  }, { needs: ['app: deploy'] }],

  ['postgres: sleeps when idle, wakes on the next connection', async () => {
    // Asleep by the hibernator's own decision, never by `hobby sleep`: the
    // point is that idle detection works, not that a stop works.
    await waitState(DB_PROJECT, 'primary', 'sleeping', SLEEP_WAIT_MS)
    const conn = await connectionString(DB_PROJECT)
    const start = Date.now()
    const got = await psql(conn, 'select marker from smoke')
    const took = since(start)
    if (got !== 'smoke-marker-42') throw new Error(`after wake, expected smoke-marker-42, got ${JSON.stringify(got)}`)
    const state = await stateOf(DB_PROJECT, 'primary')
    if (state !== 'running') throw new Error(`answered, but the daemon reports ${state}, not running`)
    return `slept ${since(facts.dbIdleSince)} after its last query; connect plus query on wake ${took}`
  }, { needs: ['postgres: create and query through the proxy'] }],

  ['app: an HTTP request wakes it from sleep', async () => {
    // A deploy leaves the app asleep ("The first request wakes it"), and the
    // hibernator would put it back there anyway; either way this asserts the
    // state before the request rather than assuming it.
    await waitState(COMPUTE_PROJECT, 'web', 'sleeping', SLEEP_WAIT_MS)
    const start = Date.now()
    const res = await httpGet(facts.appHost, '/')
    const took = since(start)
    if (res.status !== 200 || res.body.trim() !== 'hobby-smoke-app-ok') {
      throw new Error(`expected 200 hobby-smoke-app-ok, got ${res.status} ${JSON.stringify(res.body.slice(0, 200))}`)
    }
    const state = await stateOf(COMPUTE_PROJECT, 'web')
    if (state !== 'running') throw new Error(`answered, but the daemon reports ${state}, not running`)
    return `cold request ${took}`
  }, { needs: ['app: deploy'] }],

  // Issue #14's test plan, run on whatever box this runs on: a worker calls
  // env.JOBS.send() from inside its container, which needs the container to
  // resolve host.docker.internal (--add-host, worker.ts containerSpec) and the
  // daemon to be listening on this project's bridge gateway, a network created
  // after the daemon started (queueEndpoint.addHost, queue-endpoint.ts).
  ['queue: a worker produces from inside its container and another consumes', async () => {
    const marker = `smoke-msg-${randomBytes(4).toString('hex')}`
    const start = Date.now()
    const res = await httpGet(facts.producerHost, `/send?id=${marker}`)
    if (res.status !== 200 || res.body.trim() !== `sent ${marker}`) {
      throw new Error(
        `the producer did not enqueue: ${res.status} ${JSON.stringify(res.body.trim().slice(0, 400))}. ` +
          'On Linux this is the shape of issue #14: the container could not resolve or reach the queue endpoint.'
      )
    }
    const sent = since(start)
    await waitFor('the consumer to log the marker', 60_000, async () => {
      const logs = await hobby(['logs', `${COMPUTE_PROJECT}/consumer`, '--tail', '200'], { timeoutMs: 20_000 })
      return logs.code === 0 && logs.stdout.includes(`smoke-consumer received ${marker}`)
    })
    return `send() answered in ${sent}, delivered and logged by the consumer ${since(start)} after the request`
  }, { needs: ['workers: deploy a consumer and a producer'] }],

  ['branch: a copy of the database answers with the same data', async () => {
    const out = await hobbyJson(['branch', DB_PROJECT, BRANCH_PROJECT], { timeoutMs: 300_000 })
    const got = await psql(await connectionString(BRANCH_PROJECT), 'select marker from smoke')
    if (got !== 'smoke-marker-42') throw new Error(`the branch answered ${JSON.stringify(got)}, not smoke-marker-42`)
    return `clone method ${out.clone ?? 'unknown'}`
  }, { needs: ['postgres: create and query through the proxy'] }],

  ['snapshot: take one, list it, restore it into a new project', async () => {
    const out = await hobbyJson(['snapshot', DB_PROJECT], { timeoutMs: 300_000 })
    const id = out.snapshot?.snapshotId
    if (!id) throw new Error('hobby snapshot --json returned no snapshotId')
    const ls = await hobby(['snapshot', 'ls', DB_PROJECT], { timeoutMs: 30_000 })
    if (ls.code !== 0 || !ls.stdout.includes(id)) throw failure(`hobby snapshot ls did not list ${id}`, ls)
    await hobbyOk(['snapshot', 'restore', DB_PROJECT, id, '--as', RESTORE_PROJECT], { timeoutMs: 300_000 })
    const got = await psql(await connectionString(RESTORE_PROJECT), 'select marker from smoke')
    if (got !== 'smoke-marker-42') throw new Error(`the restored project answered ${JSON.stringify(got)}`)
    return `snapshot ${id}, clone method ${out.snapshot.clone ?? 'unknown'}`
  }, { needs: ['postgres: create and query through the proxy'] }],

  ['eject: emits a compose file docker compose accepts', async () => {
    const checked = []
    for (const [project, services] of [
      [DB_PROJECT, ['primary']],
      [COMPUTE_PROJECT, ['web', 'producer', 'consumer']],
    ]) {
      const res = await hobby(['eject', project], { timeoutMs: 60_000 })
      if (res.code !== 0) throw failure(`hobby eject ${project}`, res)
      // Kept under RUN_DIR, not ARTIFACTS: the file holds the database password.
      const file = join(RUN_DIR, `${project}.compose.yml`)
      writeFileSync(file, res.stdout)
      // The preview puts every service behind the hobby-released profile, so a
      // plain `docker compose up` on it starts nothing (commands.ts, cmdEject).
      const cfg = await run('docker', ['compose', '-f', file, '--profile', 'hobby-released', 'config', '--services'], {
        timeoutMs: 60_000,
      })
      if (cfg.code !== 0) throw failure(`docker compose config on the ejected ${project}`, cfg)
      const got = cfg.stdout.trim().split('\n').filter(Boolean).sort()
      const want = [...services].sort()
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        throw new Error(`ejected ${project} has services ${got.join(', ')}, expected ${want.join(', ')}`)
      }
      checked.push(`${project}: ${got.join(', ')}`)
    }
    return checked.join('; ')
  }, { needs: ['postgres: create and query through the proxy', 'workers: deploy a consumer and a producer'] }],

  // Last, because it is also the first half of teardown: the product's own
  // removal path, which on Linux has to delete data directories the container's
  // postgres uid owns (createDefaultRemoveDataDir, packages/pg/src/postgres.ts).
  ['rm: every project removes cleanly', async () => {
    const removed = []
    for (const project of ALL_PROJECTS) {
      const exists = (await listing()).some((d) => d.project.name === project)
      if (!exists) continue
      await hobbyOk(['rm', project, '--yes'], { timeoutMs: 180_000 })
      removed.push(project)
    }
    const left = await dockerLeftovers()
    if (left.length > 0) throw new Error(`hobby rm left Docker objects behind: ${left.join(', ')}`)
    return `removed ${removed.length} projects, no containers, networks or images left`
  }, { needs: ['daemon starts'] }],
]

// ---------------------------------------------------------------------------
// Teardown

async function dockerNames(args) {
  const res = await run('docker', args, { timeoutMs: 30_000 })
  return res.code === 0 ? res.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
}

// Docker's name filters are substring matches, so these list everything with
// the family's prefix and keep only this run's by an exact prefix test.
async function dockerLeftovers() {
  const mine = (n) => n.startsWith(`hobby-${PREFIX}`) || n.startsWith(`hobby/${PREFIX}`)
  const containers = (await dockerNames(['ps', '-a', '--filter', `name=hobby-${PREFIX}`, '--format', '{{.Names}}'])).filter(mine)
  const networks = (await dockerNames(['network', 'ls', '--filter', `name=hobby-${PREFIX}`, '--format', '{{.Name}}'])).filter(mine)
  const images = (await dockerNames(['images', '--format', '{{.Repository}}:{{.Tag}}'])).filter(mine)
  return [...containers.map((c) => `container ${c}`), ...networks.map((n) => `network ${n}`), ...images.map((i) => `image ${i}`)]
}

async function collectLogs() {
  const dir = join(ARTIFACTS, 'containers')
  mkdirSync(dir, { recursive: true })
  const containers = (await dockerNames(['ps', '-a', '--filter', `name=hobby-${PREFIX}`, '--format', '{{.Names}}'])).filter((n) =>
    n.startsWith(`hobby-${PREFIX}`)
  )
  for (const name of containers) {
    const res = await run('docker', ['logs', '--timestamps', name], { timeoutMs: 30_000 })
    writeFileSync(join(dir, `${name}.log`), redact(`${res.stdout}\n${res.stderr}`))
    const inspect = await run('docker', ['inspect', name], { timeoutMs: 30_000 })
    writeFileSync(join(dir, `${name}.inspect.json`), redact(inspect.stdout))
  }
  const ls = await hobby(['ls', '--json'], { timeoutMs: 15_000 })
  if (ls.code === 0) writeFileSync(join(ARTIFACTS, 'hobby-ls.json'), redact(ls.stdout))
  const ps = await run('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'], { timeoutMs: 30_000 })
  writeFileSync(join(ARTIFACTS, 'docker-ps.txt'), ps.stdout)
}

async function stopDaemon() {
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) return
  const exited = new Promise((r) => daemon.once('exit', r))
  daemon.kill('SIGTERM')
  const clean = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 60_000))])
  if (!clean) {
    say('      the daemon did not stop within 60s of SIGTERM; killing it')
    daemon.kill('SIGKILL')
    await exited
  }
  // A clean shutdown releases the lock itself. A killed one cannot, so remove
  // it here, but only when it is provably ours.
  try {
    const rec = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    if (rec.pid === daemon.pid) rmSync(LOCK_PATH, { force: true })
  } catch {
    // No lock, or not ours: leave it alone.
  }
}

async function removeHome() {
  rmSync(RUN_DIR, { recursive: true, force: true, maxRetries: 2 })
  if (!existsSync(RUN_DIR)) return
  // On Linux a data directory is owned by the container's postgres uid (70 on
  // alpine), not by whoever runs this, so a plain rm as this user fails with
  // EACCES when `hobby rm` did not get to it. Remove it from inside a
  // container, as createDefaultRemoveDataDir does. postgres:18-alpine is
  // already on the box: every scenario above that did anything pulled it.
  await run('docker', ['run', '--rm', '-v', `${RUN_DIR}:/doomed`, '--entrypoint', 'sh', 'postgres:18-alpine', '-c', 'rm -rf /doomed/*'], {
    timeoutMs: 120_000,
  })
  rmSync(RUN_DIR, { recursive: true, force: true })
}

let tornDown = false
async function teardown() {
  if (tornDown) return
  tornDown = true
  say('----  teardown')
  if (process.env.SMOKE_KEEP === '1') {
    say(`      SMOKE_KEEP=1: leaving daemon pid ${daemon?.pid} and HOBBY_HOME ${HOBBY_HOME} up`)
    return
  }
  // The product's own removal first, for anything the rm scenario did not
  // reach (it was skipped, or failed partway).
  if (daemon && daemon.exitCode === null) {
    for (const project of ALL_PROJECTS) {
      const res = await hobby(['rm', project, '--yes'], { timeoutMs: 180_000 })
      if (res.code === 0) say(`      hobby rm ${project}`)
    }
  }
  await stopDaemon()
  // The safety net: anything of this run's that is still in Docker.
  const mine = (n) => n.startsWith(`hobby-${PREFIX}`) || n.startsWith(`hobby/${PREFIX}`)
  for (const c of (await dockerNames(['ps', '-a', '--format', '{{.Names}}'])).filter(mine)) {
    await run('docker', ['rm', '-f', c], { timeoutMs: 60_000 })
    say(`      removed leftover container ${c}`)
  }
  for (const n of (await dockerNames(['network', 'ls', '--format', '{{.Name}}'])).filter(mine)) {
    await run('docker', ['network', 'rm', n], { timeoutMs: 60_000 })
    say(`      removed leftover network ${n}`)
  }
  for (const i of (await dockerNames(['images', '--format', '{{.Repository}}:{{.Tag}}'])).filter(mine)) {
    await run('docker', ['rmi', '-f', i], { timeoutMs: 60_000 })
    say(`      removed leftover image ${i}`)
  }
  await removeHome()
  say(existsSync(RUN_DIR) ? `      could not remove ${RUN_DIR}` : `      removed ${RUN_DIR}`)
}

// ---------------------------------------------------------------------------
// Main

async function preflight() {
  for (const [cmd, args, hint] of [
    ['docker', ['info', '--format', '{{.ServerVersion}}'], 'Docker must be installed and running.'],
    ['docker', ['compose', 'version'], 'the eject scenario needs the docker compose plugin.'],
    ['psql', ['--version'], 'psql is needed. Ubuntu: sudo apt-get install -y postgresql-client; macOS: brew install libpq'],
  ]) {
    const res = await run(cmd, args, { timeoutMs: 30_000 })
    if (res.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${hint}`)
  }
  // Refuse to contend with a live daemon. The lock is machine-wide by design
  // (single-instance.ts) and stopping someone else's daemon is not this
  // script's call. A stale record (dead pid) is fine: the daemon reports it.
  if (existsSync(LOCK_PATH)) {
    let rec = null
    try {
      rec = JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
    } catch {
      // unreadable: let the daemon report it
    }
    let alive = false
    if (rec?.pid) {
      try {
        process.kill(rec.pid, 0)
        alive = true
      } catch (err) {
        alive = err.code === 'EPERM'
      }
    }
    if (alive) {
      throw new Error(
        `a hobby daemon is already running (pid ${rec.pid}, HOBBY_HOME ${rec.home}) and holds ${LOCK_PATH}. ` +
          'Stop it first; the smoke test will not share a box with it.'
      )
    }
  }
}

function box() {
  return run('docker', ['info', '--format', '{{.ServerVersion}} {{.OperatingSystem}} {{.Architecture}} {{.Driver}}'], {
    timeoutMs: 30_000,
  }).then((r) => r.stdout.trim())
}

async function main() {
  const started = Date.now()
  writeFileSync(SUMMARY_LOG, '')
  say(`hobby smoke ${RUN_ID}: ${process.platform} ${process.arch}, node ${process.version}`)
  say(`docker: ${await box()}`)
  say(`ports: proxy ${PORTS.proxy}, api ${PORTS.api}, http ${PORTS.http}, queue ${PORTS.queue}; sleep after ${SLEEP_AFTER}s; caddy off`)
  say(`artifacts: ${ARTIFACTS}`)

  const onSignal = (sig) => {
    say(`\n${sig}: tearing down`)
    teardown().finally(() => process.exit(130))
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    await preflight()
    if (process.env.SMOKE_SKIP_BUILD !== '1') {
      say('----  build')
      const start = Date.now()
      const res = await run('npm', ['run', 'build'], { cwd: REPO, env: process.env, timeoutMs: 600_000 })
      writeFileSync(join(ARTIFACTS, 'build.log'), `${res.stdout}\n${res.stderr}`)
      if (res.code !== 0) throw failure('npm run build', res)
      say(`      built in ${since(start)}`)
    }
    for (const [name, fn, opts] of scenarios) await scenario(name, fn, opts)
  } catch (err) {
    results.push({ name: 'setup', status: 'FAIL', detail: redact(err.message) })
    say(`FAIL  setup: ${redact(err.message)}`)
  }

  const failed = results.some((r) => r.status !== 'PASS')
  try {
    await teardown()
  } catch (err) {
    say(`      teardown failed: ${err.message}`)
  }

  say('')
  say('==== summary')
  for (const r of results) say(`${r.status.padEnd(4)}  ${r.name}${r.took ? `  (${r.took})` : ''}`)
  const counts = ['PASS', 'FAIL', 'SKIP'].map((s) => `${results.filter((r) => r.status === s).length} ${s.toLowerCase()}`)
  say(`${counts.join(', ')} in ${since(started)}`)
  if (failed) {
    say(`daemon log and container logs: ${ARTIFACTS}`)
  } else if (process.env.SMOKE_ARTIFACTS === undefined) {
    rmSync(ARTIFACTS, { recursive: true, force: true })
  }
  process.exit(failed ? 1 : 0)
}

main().catch(async (err) => {
  console.error(`smoke runner crashed: ${err?.stack ?? err}`)
  try {
    await teardown()
  } catch {
    // best effort
  }
  process.exit(1)
})
