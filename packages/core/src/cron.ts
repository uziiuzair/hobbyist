// Five-field cron expressions, the dialect Cloudflare's `[triggers] crons`
// uses: minute, hour, day of month, month, day of week, evaluated in UTC.
// `*`, lists (`1,15`), ranges (`1-5`), steps (`*/5`, `1-30/10`), and the
// three-letter month and weekday names. Both `0` and `7` are Sunday. When
// the day-of-month and day-of-week fields are both restricted, a day
// matches if EITHER does, which is what Vixie cron and Cloudflare do, and
// not what someone reading the two fields as a conjunction would expect.
//
// Hand-written rather than a dependency because the daemon ships as one
// binary (ADR 0006) and a cron parser is forty lines, not a library. There
// is no `L`, `W` or `#`: Cloudflare accepts some of those, and a worker
// using them is refused at deploy time with the expression named, which is
// better than silently firing on the wrong day.

import { HobbyError } from './errors.js'

export interface CronSchedule {
  expression: string
  minutes: Set<number>
  hours: Set<number>
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  // Whether each day field was `*`, which decides the either/or rule above.
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

interface FieldSpec {
  name: string
  min: number
  max: number
  names?: string[]
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS },
  { name: 'day of week', min: 0, max: 7, names: DAYS },
]

function invalid(expression: string, detail: string): HobbyError {
  return new HobbyError('usage', `invalid cron expression ${JSON.stringify(expression)}`, detail)
}

function parseValue(raw: string, spec: FieldSpec, expression: string): number {
  const lower = raw.toLowerCase()
  if (spec.names !== undefined) {
    const index = spec.names.indexOf(lower)
    if (index !== -1) {
      return spec.min === 0 ? index : index + 1
    }
  }
  if (!/^\d+$/.test(raw)) {
    throw invalid(expression, `${JSON.stringify(raw)} is not a number in the ${spec.name} field`)
  }
  const value = Number(raw)
  if (value < spec.min || value > spec.max) {
    throw invalid(expression, `${raw} is out of range for ${spec.name} (${spec.min} to ${spec.max})`)
  }
  return value
}

function parseField(field: string, spec: FieldSpec, expression: string): Set<number> {
  const out = new Set<number>()
  for (const item of field.split(',')) {
    if (item.length === 0) {
      throw invalid(expression, `empty entry in the ${spec.name} field`)
    }
    const [rangePart, stepPart, extra] = item.split('/')
    if (extra !== undefined || rangePart === undefined) {
      throw invalid(expression, `${JSON.stringify(item)} has more than one / in the ${spec.name} field`)
    }
    let step = 1
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw invalid(expression, `step ${JSON.stringify(stepPart)} in the ${spec.name} field must be a positive number`)
      }
      step = Number(stepPart)
    }
    let from: number
    let to: number
    if (rangePart === '*') {
      from = spec.min
      to = spec.max
    } else if (rangePart.includes('-')) {
      const [a, b, more] = rangePart.split('-')
      if (more !== undefined || a === undefined || b === undefined) {
        throw invalid(expression, `${JSON.stringify(rangePart)} is not a range in the ${spec.name} field`)
      }
      from = parseValue(a, spec, expression)
      to = parseValue(b, spec, expression)
      if (from > to) {
        throw invalid(expression, `range ${rangePart} in the ${spec.name} field runs backwards`)
      }
    } else {
      from = parseValue(rangePart, spec, expression)
      // `5/15` means every 15 starting at 5, as in Vixie cron; a bare value
      // is just itself.
      to = stepPart === undefined ? from : spec.max
    }
    for (let value = from; value <= to; value += step) {
      out.add(value)
    }
  }
  // Day of week: 7 is Sunday too.
  if (spec.names === DAYS && out.has(7)) {
    out.delete(7)
    out.add(0)
  }
  return out
}

export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw invalid(expression, `expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`)
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  return {
    expression,
    minutes: parseField(minute, FIELDS[0] as FieldSpec, expression),
    hours: parseField(hour, FIELDS[1] as FieldSpec, expression),
    daysOfMonth: parseField(dayOfMonth, FIELDS[2] as FieldSpec, expression),
    months: parseField(month, FIELDS[3] as FieldSpec, expression),
    daysOfWeek: parseField(dayOfWeek, FIELDS[4] as FieldSpec, expression),
    anyDayOfMonth: dayOfMonth === '*',
    anyDayOfWeek: dayOfWeek === '*',
  }
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  const domMatch = schedule.daysOfMonth.has(date.getUTCDate())
  const dowMatch = schedule.daysOfWeek.has(date.getUTCDay())
  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek) return true
  if (schedule.anyDayOfMonth) return dowMatch
  if (schedule.anyDayOfWeek) return domMatch
  return domMatch || dowMatch
}

const MINUTE_MS = 60_000
const FIVE_YEARS_MS = 5 * 366 * 24 * 60 * MINUTE_MS

// The first time strictly after `afterMs` the schedule fires, in UTC, as
// milliseconds since the epoch. Walks forward from the next whole minute,
// skipping a whole month, day or hour at a time when that field cannot
// match, so even `0 0 29 2 *` (every leap day) resolves in a few hundred
// steps. Five years with no match is refused rather than looping on: the
// expression is one nothing will ever satisfy (`0 0 31 2 *`).
export function nextCronTime(schedule: CronSchedule, afterMs: number): number {
  let t = (Math.floor(afterMs / MINUTE_MS) + 1) * MINUTE_MS
  const limit = afterMs + FIVE_YEARS_MS
  while (t <= limit) {
    const date = new Date(t)
    if (!schedule.months.has(date.getUTCMonth() + 1)) {
      t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
      continue
    }
    if (!dayMatches(schedule, date)) {
      t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
      continue
    }
    if (!schedule.hours.has(date.getUTCHours())) {
      t = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1)
      continue
    }
    if (!schedule.minutes.has(date.getUTCMinutes())) {
      t += MINUTE_MS
      continue
    }
    return t
  }
  throw invalid(schedule.expression, 'it never fires: no date in the next five years matches it')
}
