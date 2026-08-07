import type { WakingSnapshot } from '../lib/useWaking.js'

// The visible half of the interaction that sells the product: named
// database, plain statement that it is waking, a clock that only goes up.
// No indeterminate spinner standing in for an explanation.

const SUBTLE_THRESHOLD_MS = 900

function formatSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function WakingBanner({ resourceName, snapshot }: { resourceName: string; snapshot: WakingSnapshot }) {
  if (snapshot.phase === 'idle' || snapshot.phase === 'error') return null

  if (snapshot.phase === 'waking') {
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
