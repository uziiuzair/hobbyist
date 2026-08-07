import { join } from 'node:path'
import { writeFileSync, rmSync } from 'node:fs'
import { prepareFixture } from './fixture.ts'
import { removeIfExists } from './runtime.ts'
import { runCell, type CellResult } from './harness.ts'
import { SCENARIOS } from './scenarios.ts'
import { renderReport, type Env } from './report.ts'

const ITERATIONS = Number(process.env.M0_ITERATIONS ?? 50)
const NAME = 'm0-bench'
const HOST_PORT = 55432
const LISTEN_PORT = 55433
// Required, and deliberately not defaulted to a temp directory. On many Linux
// distributions /tmp is tmpfs, which is RAM, and a benchmark whose data
// directory lives in RAM measures the wrong thing entirely while looking
// excellent. Point this at the disk the results claim to describe.
const DATA_DIR = process.env.M0_DATA_DIR

function envFromArgs(): Env {
  const need = (k: string): string => {
    const v = process.env[k]
    if (!v) throw new Error(`set ${k}, the results are worthless without it`)
    return v
  }
  return {
    machine: need('M0_MACHINE'),
    cpu: need('M0_CPU'),
    ram: need('M0_RAM'),
    disk: need('M0_DISK'),
    filesystem: need('M0_FS'),
    os: need('M0_OS'),
    runtime: need('M0_RUNTIME'),
    runtimeVersion: need('M0_RUNTIME_VERSION'),
    cachesDropped: process.platform === 'linux',
  }
}

if (!DATA_DIR) throw new Error('set M0_DATA_DIR to a path on the disk being measured, not /tmp')

const env = envFromArgs()
const results: CellResult[] = []

for (const scenario of SCENARIOS) {
  process.stderr.write(`running ${scenario.label}\n`)
  await removeIfExists(NAME)
  // Each scenario gets its own directory rather than one shared path that is
  // deleted and recreated between scenarios. Deleting the source of a bind
  // mount and recreating it at the same path leaves the previous mount
  // pointing at a dead inode, and the next container then sees a directory it
  // cannot write into. Observed on macOS with OrbStack: scenario one passed,
  // scenario two died with "mkdir: can't create directory
  // '/var/lib/postgresql/18/': No such file or directory".
  const scenarioDir = join(DATA_DIR, scenario.label)
  rmSync(scenarioDir, { recursive: true, force: true })
  const fixture = await prepareFixture({
    name: NAME,
    image: scenario.image,
    hostPort: HOST_PORT,
    dataDir: scenarioDir,
  })
  results.push(
    await runCell({
      label: scenario.label,
      fixture,
      listenPort: LISTEN_PORT,
      pollMs: scenario.pollMs,
      iterations: ITERATIONS,
      reset: scenario.reset,
      dropCaches: scenario.dropCaches,
    }),
  )
}

await removeIfExists(NAME)
rmSync(DATA_DIR, { recursive: true, force: true })

const out = `m0-${env.machine}-${env.runtime}.md`
writeFileSync(out, renderReport(env, results))
process.stderr.write(`wrote ${out}\n`)
