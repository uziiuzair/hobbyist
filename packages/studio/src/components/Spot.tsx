// Spot drawings for empty states: inline SVG, currentColor, no external
// anything. The drawing carries the warmth so the copy can stay plain. Each
// is drawn at 52x44 with a 1.4 stroke, dim ink via the empty-art class.

export function SpotCrate() {
  return (
    <svg className="empty-art" width="52" height="44" viewBox="0 0 52 44" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <rect x="8" y="16" width="36" height="22" rx="4" />
      <path d="M8 24h36" />
      <path d="M26 16V9" />
      <path d="M26 9c0-4 4-5 6-3M26 9c0-4-4-5-6-3" />
    </svg>
  )
}

export function SpotTerminal() {
  return (
    <svg className="empty-art" width="52" height="44" viewBox="0 0 52 44" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <rect x="8" y="6" width="36" height="30" rx="4" />
      <path d="M15 16l5 5-5 5M24 26h8" strokeLinejoin="round" />
    </svg>
  )
}

export function SpotColumns() {
  return (
    <svg className="empty-art" width="52" height="44" viewBox="0 0 52 44" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <rect x="8" y="7" width="36" height="30" rx="4" />
      <path d="M8 15h36M20 15v22M32 15v22" />
    </svg>
  )
}

export function SpotRows() {
  return (
    <svg className="empty-art" width="52" height="44" viewBox="0 0 52 44" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      <rect x="8" y="7" width="36" height="9" rx="3" />
      <rect x="8" y="20" width="36" height="9" rx="3" />
      <rect x="8" y="33" width="24" height="9" rx="3" />
    </svg>
  )
}
