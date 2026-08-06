import type { ResetMode } from './harness.ts'

export type Scenario = {
  label: string
  image: string
  pollMs: number
  reset: ResetMode
  dropCaches: boolean
}

// One scenario per lever, each differing from the baseline in exactly one way,
// so a difference in the results has exactly one explanation.
//
//   lever 1  stopped versus recreated       baseline vs recreate
//   lever 2  clean stop versus SIGKILL      baseline vs kill
//   lever 3  poll interval                  poll25 vs poll100 vs poll1000
//   free     base image                     alpine vs debian
//   context  page cache                     warm vs cold
export const SCENARIOS: Scenario[] = [
  { label: 'baseline-alpine-poll25', image: 'postgres:18-alpine', pollMs: 25, reset: 'stop', dropCaches: false },
  { label: 'poll100-alpine', image: 'postgres:18-alpine', pollMs: 100, reset: 'stop', dropCaches: false },
  { label: 'poll1000-alpine', image: 'postgres:18-alpine', pollMs: 1000, reset: 'stop', dropCaches: false },
  { label: 'debian-poll25', image: 'postgres:18', pollMs: 25, reset: 'stop', dropCaches: false },
  { label: 'kill-alpine-poll25', image: 'postgres:18-alpine', pollMs: 25, reset: 'kill', dropCaches: false },
  { label: 'recreate-alpine-poll25', image: 'postgres:18-alpine', pollMs: 25, reset: 'recreate', dropCaches: false },
  { label: 'coldcache-alpine-poll25', image: 'postgres:18-alpine', pollMs: 25, reset: 'stop', dropCaches: true },
]
