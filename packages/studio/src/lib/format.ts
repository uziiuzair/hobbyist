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

export interface WireResource {
  state: string
  sizeBytes?: number
  connectionCount?: number
  lastActiveAt?: string | null
}

export function readStats(resource: unknown): WireResource {
  return resource as WireResource
}
