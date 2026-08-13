import { formatBytes } from '../lib/format.js'

// The instrument line: the machine itself, in one row. Every figure here is
// real at render time; anything the daemon cannot answer (uptime, RAM) is
// absent, not estimated, because a reader must never execute an aspiration.
export function MachineStrip({ awake, total, freeBytes }: { awake: number; total: number; freeBytes: number | null }) {
  const host = window.location.hostname
  return (
    <div className="machine">
      <span className="machine-host">{host}</span>
      <span className="machine-cluster" aria-hidden="true">
        {Array.from({ length: Math.min(total, 12) }, (_, i) => (
          <i key={i} className={i < awake ? 'on' : ''} />
        ))}
      </span>
      <span>
        {awake} of {total} awake
      </span>
      {freeBytes !== null && <span className="machine-right">{formatBytes(freeBytes)} free</span>}
    </div>
  )
}
