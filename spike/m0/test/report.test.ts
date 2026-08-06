import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderReport } from '../src/report.ts'
import { SCENARIOS } from '../src/scenarios.ts'

const env = {
  machine: 'test',
  cpu: '1 vCPU',
  ram: '1GB',
  disk: 'nvme',
  filesystem: 'ext4',
  os: 'Debian 12',
  runtime: 'bun',
  runtimeVersion: '1.1.0',
  cachesDropped: true,
}

const result = {
  label: 'baseline',
  iterations: 50,
  segments: {
    accept_parse: { n: 50, p50: 0.4, p95: 0.9, max: 2 },
    wake_issue: { n: 50, p50: 30, p95: 45, max: 60 },
    container_up: { n: 50, p50: 180, p95: 240, max: 300 },
    pg_ready: { n: 50, p50: 400, p95: 620, max: 900 },
    connect_splice: { n: 50, p50: 5, p95: 9, max: 14 },
  },
  total: { n: 50, p50: 615, p95: 915, max: 1276 },
  failures: 0,
}

test('the report states the hardware, because a benchmark without it is a rumour', () => {
  const md = renderReport(env, [result])
  assert.ok(md.includes('1 vCPU'))
  assert.ok(md.includes('ext4'))
  assert.ok(md.includes('bun 1.1.0'))
})

test('the report answers the gate rather than leaving it to the reader', () => {
  const md = renderReport(env, [result])
  assert.ok(md.includes('Gate:'))
  assert.ok(md.includes('915'))
})

test('a p95 over 3000ms is reported as a blocker', () => {
  const bad = { ...result, total: { n: 50, p50: 2000, p95: 3400, max: 4000 } }
  assert.ok(renderReport(env, [bad]).includes('BLOCKER'))
})

test('every scenario has a distinct label, so report rows cannot collide', () => {
  const labels = SCENARIOS.map((s) => s.label)
  assert.equal(new Set(labels).size, labels.length)
})

test('the report contains no em-dashes', () => {
  assert.ok(!renderReport(env, [result]).includes('—'))
})
