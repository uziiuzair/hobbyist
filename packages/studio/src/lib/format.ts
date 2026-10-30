export function formatBytes(bytes: number | undefined | null): string {
  if (bytes === undefined || bytes === null || Number.isNaN(bytes)) return '--'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

// Deliberately coarse. A dashboard that says "4 minutes ago" invites you to
// read it as live truth; the daemon's own idle threshold is 300 seconds, so
// anything finer than a minute is noise the operator cannot act on.
export function formatSince(iso: string | null | undefined): string {
  if (iso === undefined || iso === null) return 'not yet'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'not yet'
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(then).toLocaleDateString()
}

// A configured duration, rendered exactly (issue #126). A sleep timeout is a
// number the operator typed (`hobby unpin blog --sleep-after 30`), so the
// page has to say the number back: 30 is "30 seconds", not the "1 minute"
// that Math.round(30 / 60) produced, and 90 is "1 minute 30 seconds". Units
// that are zero are left out, so 3600 is "1 hour" and 60 is "1 minute".
// formatSince above stays coarse on purpose; it describes an elapsed time,
// this describes a setting.
export function formatDuration(totalSeconds: number): string {
  const parts = durationParts(totalSeconds)
  if (parts.length === 0) return '0 seconds'
  return parts.map(([n, unit]) => `${n} ${unit}${n === 1 ? '' : 's'}`).join(' ')
}

// The same breakdown in the compact form a stat row has room for: "30s",
// "1m 30s", "1h".
export function formatDurationShort(totalSeconds: number): string {
  const parts = durationParts(totalSeconds)
  if (parts.length === 0) return '0s'
  return parts.map(([n, unit]) => `${n}${unit[0]}`).join(' ')
}

type DurationUnit = 'hour' | 'minute' | 'second'

function durationParts(totalSeconds: number): Array<[number, DurationUnit]> {
  const whole = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const seconds = whole % 60
  const parts: Array<[number, DurationUnit]> = []
  if (hours > 0) parts.push([hours, 'hour'])
  if (minutes > 0) parts.push([minutes, 'minute'])
  if (seconds > 0) parts.push([seconds, 'second'])
  return parts
}

export interface WireResource {
  state: string
  sizeBytes?: number
  connectionCount?: number
  lastActiveAt?: string | null
}

export function readStats(resource: unknown): WireResource {
  return resource as WireResource
}
