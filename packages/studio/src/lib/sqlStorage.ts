// SQL history and saved snippets, kept in localStorage rather than on the
// daemon: they are a per-browser editing convenience, not project state,
// and Studio has no route for them (nor should it need one). Every function
// here takes a Storage-shaped object rather than reading window.localStorage
// directly, so the round-trip is testable with a fake, in-memory Storage
// and no browser or network involved.

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface HistoryEntry {
  id: string
  resourceId: string
  sql: string
  ranAt: string
  ok: boolean
  errorMessage?: string
}

export interface Snippet {
  id: string
  name: string
  sql: string
  savedAt: string
}

const HISTORY_KEY = 'hobbystudio:sql:history'
const SNIPPETS_KEY = 'hobbystudio:sql:snippets'
const MAX_HISTORY = 200

function readArray<T>(storage: StorageLike, key: string): T[] {
  const raw = storage.getItem(key)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function writeArray<T>(storage: StorageLike, key: string, value: T[]): void {
  storage.setItem(key, JSON.stringify(value))
}

export function loadHistory(storage: StorageLike, resourceId?: string): HistoryEntry[] {
  const all = readArray<HistoryEntry>(storage, HISTORY_KEY)
  return resourceId === undefined ? all : all.filter((entry) => entry.resourceId === resourceId)
}

// Newest first, capped at MAX_HISTORY total entries across all resources so
// the key cannot grow without bound over a long-lived install.
export function pushHistory(storage: StorageLike, entry: HistoryEntry): HistoryEntry[] {
  const all = readArray<HistoryEntry>(storage, HISTORY_KEY)
  const next = [entry, ...all].slice(0, MAX_HISTORY)
  writeArray(storage, HISTORY_KEY, next)
  return next
}

export function clearHistory(storage: StorageLike, resourceId?: string): void {
  if (resourceId === undefined) {
    writeArray(storage, HISTORY_KEY, [])
    return
  }
  const remaining = readArray<HistoryEntry>(storage, HISTORY_KEY).filter((entry) => entry.resourceId !== resourceId)
  writeArray(storage, HISTORY_KEY, remaining)
}

export function loadSnippets(storage: StorageLike): Snippet[] {
  return readArray<Snippet>(storage, SNIPPETS_KEY)
}

export function saveSnippet(storage: StorageLike, snippet: Snippet): Snippet[] {
  const all = readArray<Snippet>(storage, SNIPPETS_KEY)
  const withoutExisting = all.filter((s) => s.id !== snippet.id)
  const next = [...withoutExisting, snippet].sort((a, b) => a.name.localeCompare(b.name))
  writeArray(storage, SNIPPETS_KEY, next)
  return next
}

export function deleteSnippet(storage: StorageLike, id: string): Snippet[] {
  const next = readArray<Snippet>(storage, SNIPPETS_KEY).filter((s) => s.id !== id)
  writeArray(storage, SNIPPETS_KEY, next)
  return next
}
