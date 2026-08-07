import type { WakingSnapshot } from '../lib/useWaking.js'

// The visible half of the interaction that sells the product: named
// database, plain statement that it is waking, a clock that only goes up.
// No indeterminate spinner standing in for an explanation.

const SUBTLE_THRESHOLD_MS = 900

// A wake that lands inside this window needed no explanation, and flashing a
// banner on and off is worse than saying nothing. The measured cold start is
// roughly 300ms on developer hardware, so most wakes never render this at all;
// it appears when the wait becomes a wait.
const WAKING_THRESHOLD_MS = 350

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function WakingBanner({ resourceName, snapshot }: { resourceName: string; snapshot: WakingSnapshot }) {
  if (snapshot.phase === 'idle') return null

  // A failed wake keeps its account: how long it tried for is the useful part,
  // and dropping the banner left a bare error with no context.
  if (snapshot.phase === 'error') {
    return (
      <div className="waking-banner waking-banner-failed" role="status" aria-live="polite">
        <span className="waking-dot" aria-hidden="true" />
        <span className="waking-text">
          <strong>{resourceName}</strong> did not come up
          <span className="waking-detail">The error below is what the daemon reported.</span>
        </span>
        <span className="waking-elapsed">{formatSeconds(snapshot.elapsedMs)}</span>
      </div>
    )
  }

  if (snapshot.phase === 'waking') {
    if (snapshot.elapsedMs < WAKING_THRESHOLD_MS) return null
    const detail =
      snapshot.resourceState === 'starting'
        ? 'Starting the container.'
        : snapshot.resourceState === 'stopping'
          ? 'Finishing the previous stop before it can start again.'
          : 'Sleeping databases restart on the first query after they wake.'
    return (
      <div className="waking-banner" role="status" aria-live="polite">
        <span className="waking-dot" aria-hidden="true" />
        <span className="waking-text">
          <strong>{resourceName}</strong> is waking up
          <span className="waking-detail">{detail}</span>
        </span>
        <span className="waking-elapsed">{formatSeconds(snapshot.elapsedMs)}</span>
      </div>
    )
  }

  // Already running: only say something once the wait has become
  // noticeable, and say something different, because this is not a wake.
  if (snapshot.elapsedMs < SUBTLE_THRESHOLD_MS) return null

  return (
    <div className="waking-banner waking-banner-subtle" role="status" aria-live="polite">
      <span className="waking-dot" aria-hidden="true" />
      <span className="waking-text">
        Still working on <strong>{resourceName}</strong>
      </span>
      <span className="waking-elapsed">{formatSeconds(snapshot.elapsedMs)}</span>
    </div>
  )
}
