export type Summary = { n: number; p50: number; p95: number; max: number }

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of empty sample')
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (rank - lo) * (sorted[hi]! - sorted[lo]!)
}

export function summarise(samples: number[]): Summary {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: percentile(sorted, 100),
  }
}
