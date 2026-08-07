// A router sized to six views: no dependency, hash-based so the daemon can
// serve Studio as plain static files with no server-side rewrite rule for
// deep links (nginx/Caddy history-mode SPA fallback is a config Task 10 has
// not built and does not need to).

import { useEffect, useState } from 'react'

function readSegments(): string[] {
  const hash = window.location.hash.replace(/^#\/?/, '')
  return hash.length === 0 ? [] : hash.split('/').map(decodeURIComponent)
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('/') ? path : `/${path}`
}

export function useHashRoute(): string[] {
  const [segments, setSegments] = useState<string[]>(readSegments)

  useEffect(() => {
    const onChange = (): void => setSegments(readSegments())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return segments
}
