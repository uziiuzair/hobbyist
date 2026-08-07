import { useEffect, useRef, useState } from 'react'

// The only honest chart this product can draw.
//
// A hosted platform bills you, so it keeps a metrics store and can show you
// last month. Nothing here writes a time series to disk, and inventing one
// would be the exact thing CLAUDE.md forbids: a reader must never execute an
// aspiration. So this samples while the page is open and says so.
//
// What it plots is the wedge itself. The hatched bands are the minutes the
// database was asleep, costing nothing but the disk it sits on, and the green
// line is the connections that woke it. Every other dashboard in this category
// draws CPU. This one draws the thing that makes the CPU line optional.

export interface Sample {
  at: number
  connections: number
  awake: boolean
}

const HEIGHT = 152
const PAD_LEFT = 26
const PAD_RIGHT = 8
const PAD_TOP = 10
const PAD_BOTTOM = 20

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const node = ref.current
    if (node === null) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setWidth(entry.contentRect.width)
    })
    observer.observe(node)
    setWidth(node.clientWidth)
    return () => observer.disconnect()
  }, [])

  return [ref, width]
}

function clockLabel(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function ActivityChart({ samples, windowMs }: { samples: Sample[]; windowMs: number }) {
  const [ref, width] = useWidth()

  const now = samples.length > 0 ? (samples[samples.length - 1]?.at ?? Date.now()) : Date.now()
  const start = now - windowMs
  const plotW = Math.max(0, width - PAD_LEFT - PAD_RIGHT)
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM

  const peak = Math.max(1, ...samples.map((s) => s.connections))
  const xFor = (at: number): number => PAD_LEFT + ((at - start) / windowMs) * plotW
  const yFor = (value: number): number => PAD_TOP + plotH - (value / peak) * plotH

  // Runs of consecutive asleep samples become one band each, so a database
  // that slept for four minutes is one shape rather than eighty rectangles.
  const bands: Array<{ from: number; to: number }> = []
  for (const sample of samples) {
    if (sample.awake) continue
    const last = bands[bands.length - 1]
    if (last !== undefined && sample.at - last.to <= windowMs / 40) last.to = sample.at
    else bands.push({ from: sample.at, to: sample.at })
  }

  const points = samples.map((s) => [xFor(s.at), yFor(s.connections)] as const)
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const first = points[0]
  const lastPoint = points[points.length - 1]
  const last = samples[samples.length - 1]
  const floor = (PAD_TOP + plotH).toFixed(1)
  const area =
    points.length > 1 && first !== undefined && lastPoint !== undefined
      ? [
          `M${first[0].toFixed(1)},${floor}`,
          ...points.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`),
          `L${lastPoint[0].toFixed(1)},${floor}`,
          'Z',
        ].join(' ')
      : null

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label="Connections over time, with the periods asleep marked">
          <defs>
            <pattern id="asleep-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--line-strong)" strokeWidth="1.6" />
            </pattern>
          </defs>

          {/* Baseline and ceiling only. A full grid on a chart this short is
              decoration competing with a single line. */}
          <line x1={PAD_LEFT} y1={PAD_TOP} x2={width - PAD_RIGHT} y2={PAD_TOP} stroke="var(--line)" strokeWidth="1" />
          <line
            x1={PAD_LEFT}
            y1={PAD_TOP + plotH}
            x2={width - PAD_RIGHT}
            y2={PAD_TOP + plotH}
            stroke="var(--line-strong)"
            strokeWidth="1"
          />

          {bands.map((band) => (
            <rect
              key={band.from}
              x={xFor(band.from)}
              y={PAD_TOP}
              width={Math.max(1.5, xFor(band.to) - xFor(band.from))}
              height={plotH}
              fill="url(#asleep-hatch)"
              opacity="0.5"
            />
          ))}

          {area !== null && <path d={area} fill="var(--accent-dim)" />}
          {samples.length > 1 && (
            <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.6" strokeLinejoin="round" />
          )}
          {samples.length === 1 && last !== undefined && (
            <circle cx={xFor(last.at)} cy={yFor(last.connections)} r="2.5" fill="var(--accent)" />
          )}

          <text x="0" y={PAD_TOP + 4} className="chart-axis">
            {peak}
          </text>
          <text x="0" y={PAD_TOP + plotH + 4} className="chart-axis">
            0
          </text>
          <text x={PAD_LEFT} y={HEIGHT - 5} className="chart-axis">
            {clockLabel(start)}
          </text>
          <text x={width - PAD_RIGHT} y={HEIGHT - 5} textAnchor="end" className="chart-axis">
            {clockLabel(now)}
          </text>
        </svg>
      )}

      <div className="chart-legend">
        <span className="legend-item">
          <span className="legend-hatch" aria-hidden="true" />
          Asleep
        </span>
        <span className="legend-item">
          <span className="legend-line" aria-hidden="true" />
          Connections
        </span>
      </div>
    </div>
  )
}
