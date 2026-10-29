import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HobbyError } from '../src/errors.js'
import { nextCronTime, parseCron } from '../src/cron.js'

const at = (iso: string): number => Date.parse(iso)
const next = (expr: string, after: string): string => new Date(nextCronTime(parseCron(expr), at(after))).toISOString()

test('every five minutes rolls to the next multiple, strictly after the given time', () => {
  assert.equal(next('*/5 * * * *', '2026-10-29T12:03:10Z'), '2026-10-29T12:05:00.000Z')
  // Exactly on a match is not "after" it.
  assert.equal(next('*/5 * * * *', '2026-10-29T12:05:00Z'), '2026-10-29T12:10:00.000Z')
  assert.equal(next('*/5 * * * *', '2026-10-29T12:04:59.999Z'), '2026-10-29T12:05:00.000Z')
})

test('hour and day boundaries are crossed in UTC', () => {
  assert.equal(next('30 2 * * *', '2026-10-29T03:00:00Z'), '2026-10-30T02:30:00.000Z')
  assert.equal(next('0 0 1 * *', '2026-10-29T00:00:00Z'), '2026-11-01T00:00:00.000Z')
  assert.equal(next('0 9 * * mon-fri', '2026-10-30T10:00:00Z'), '2026-11-02T09:00:00.000Z') // Friday to Monday
  assert.equal(next('0 0 29 2 *', '2026-01-01T00:00:00Z'), '2028-02-29T00:00:00.000Z')
})

test('names, lists, ranges, steps with offsets, and 7 as Sunday', () => {
  const s = parseCron('5/15 1,13 1-7 JAN,jul 7')
  assert.deepEqual([...s.minutes], [5, 20, 35, 50])
  assert.deepEqual([...s.hours], [1, 13])
  assert.deepEqual([...s.daysOfMonth], [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual([...s.months], [1, 7])
  assert.deepEqual([...s.daysOfWeek], [0])
})

test('day of month and day of week together match either, as Vixie cron and Cloudflare do', () => {
  // The 13th or a Friday, whichever comes first.
  assert.equal(next('0 0 13 * fri', '2026-10-29T00:00:00Z'), '2026-10-30T00:00:00.000Z') // Friday the 30th
  assert.equal(next('0 0 13 * fri', '2026-11-07T00:00:00Z'), '2026-11-13T00:00:00.000Z') // the 13th before the next Friday
})

test('malformed expressions are refused with the expression and the field named', () => {
  const refuses = (expr: string, re: RegExp): void => {
    assert.throws(
      () => parseCron(expr),
      (err: unknown) => err instanceof HobbyError && err.code === 'usage' && err.message.includes(expr) && re.test(err.hint ?? '')
    )
  }
  refuses('* * * *', /expected 5 fields/)
  refuses('60 * * * *', /out of range for minute/)
  refuses('* * * * 8', /out of range for day of week/)
  refuses('*/0 * * * *', /step/)
  refuses('a * * * *', /not a number/)
  refuses('5-1 * * * *', /backwards/)
  assert.throws(
    () => nextCronTime(parseCron('0 0 31 2 *'), at('2026-01-01T00:00:00Z')),
    (err: unknown) => err instanceof HobbyError && /never fires/.test(err.hint ?? '')
  )
})
