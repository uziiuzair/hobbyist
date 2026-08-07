import type { CellResult } from './harness.ts'

export type Env = {
  machine: string
  cpu: string
  ram: string
  disk: string
  filesystem: string
  os: string
  runtime: string
  runtimeVersion: string
  cachesDropped: boolean
}

const TARGET_MS = 1000
const CEILING_MS = 3000

export function renderReport(env: Env, results: CellResult[]): string {
  const lines: string[] = []

  lines.push('## Hardware')
  lines.push('')
  lines.push(`- Machine: ${env.machine}`)
  lines.push(`- CPU: ${env.cpu}`)
  lines.push(`- RAM: ${env.ram}`)
  lines.push(`- Disk: ${env.disk}`)
  lines.push(`- Filesystem: ${env.filesystem}`)
  lines.push(`- OS: ${env.os}`)
  lines.push(`- Runtime: ${env.runtime} ${env.runtimeVersion}`)
  lines.push(`- Page cache dropped between iterations: ${env.cachesDropped ? 'yes' : 'no'}`)
  lines.push('')

  lines.push('## Results, milliseconds')
  lines.push('')
  lines.push('| scenario | n | fail | accept_parse p50 | wake_issue p50 | container_up p50 | pg_ready p50 | connect_splice p50 | total p50 | total p95 | total max |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    lines.push(
      `| ${r.label} | ${r.iterations} | ${r.failures} | ` +
        `${fmt(r.segments.accept_parse?.p50)} | ${fmt(r.segments.wake_issue?.p50)} | ` +
        `${fmt(r.segments.container_up?.p50)} | ${fmt(r.segments.pg_ready?.p50)} | ` +
        `${fmt(r.segments.connect_splice?.p50)} | ` +
        `${fmt(r.total.p50)} | ${fmt(r.total.p95)} | ${fmt(r.total.max)} |`,
    )
  }
  lines.push('')

  const worst = Math.max(...results.map((r) => r.total.p95))
  lines.push('## Gate')
  lines.push('')
  lines.push(`Target ${TARGET_MS}ms, hard ceiling ${CEILING_MS}ms, measured on total p95.`)
  lines.push('')
  lines.push(`Gate: worst total p95 across scenarios is ${fmt(worst)}ms. ${verdict(worst)}`)
  lines.push('')

  return lines.join('\n')
}

function verdict(worstP95: number): string {
  if (worstP95 < TARGET_MS) return 'Under target. Proceed to M1 as designed.'
  if (worstP95 <= CEILING_MS) {
    return 'Over target but under the ceiling. Proceed, publish the real number, revisit the levers in M2.'
  }
  return 'BLOCKER. Over the 3000ms ceiling. A warm pool becomes mandatory or the wedge is re-examined, and either way it needs an ADR before M1 continues.'
}

function fmt(v: number | undefined): string {
  return v === undefined ? 'n/a' : v.toFixed(1)
}
