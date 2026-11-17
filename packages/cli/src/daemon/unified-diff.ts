// A line diff in unified format, for `hobby diff` (schema-diff.ts). Written
// here rather than taken as a dependency or shelled out to `diff -u`: the
// daemon depends on no diff library, `diff` is not guaranteed on every box
// (a minimal container image may lack it), and the structured --json output
// needs the hunks as data anyway, which parsing diff's text back would only
// approximate.
//
// The algorithm is Myers' O(ND) greedy diff ("An O(ND) Difference Algorithm
// and Its Variations", 1986), the one GNU diff and git use by default, with
// the usual backtrack over saved V arrays. D is the number of changed lines,
// so two schema dumps that differ by a handful of statements cost almost
// nothing however long they are. Hunks carry three lines of context, as
// `diff -u` does.

export type DiffOp = ' ' | '-' | '+'

export interface DiffLine {
  op: DiffOp
  text: string
}

export interface DiffHunk {
  // 1-based, as in a `@@ -a,b +c,d @@` header. A side with no lines in the
  // hunk reports the line before it, which is 0 at the top of a file, again
  // as diff does.
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

const CONTEXT = 3

// The shortest edit script, as one entry per line of either input.
export function diffLines(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const max = n + m
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []

  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))) {
        x = v[offset + k + 1] as number
      } else {
        x = (v[offset + k - 1] as number) + 1
      }
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }

  // Backtrack from (n, m) through the saved frontiers, collecting the edit
  // in reverse.
  const out: DiffLine[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const saved = trace[d] as Int32Array
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && (saved[offset + k - 1] as number) < (saved[offset + k + 1] as number))) {
      prevK = k + 1
    } else {
      prevK = k - 1
    }
    const prevX = d === 0 ? 0 : (saved[offset + prevK] as number)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      out.push({ op: ' ', text: a[x - 1] as string })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) {
        out.push({ op: '+', text: b[y - 1] as string })
      } else {
        out.push({ op: '-', text: a[x - 1] as string })
      }
    }
    x = prevX
    y = prevY
  }
  return out.reverse()
}

// Groups an edit script into hunks with CONTEXT lines either side, merging
// hunks whose context would overlap. No changes, no hunks.
export function toHunks(lines: DiffLine[]): DiffHunk[] {
  const changed: number[] = []
  lines.forEach((line, index) => {
    if (line.op !== ' ') changed.push(index)
  })
  if (changed.length === 0) {
    return []
  }

  // Ranges of edit-script indexes, each a change plus its context.
  const ranges: Array<[number, number]> = []
  for (const index of changed) {
    const from = Math.max(0, index - CONTEXT)
    const to = Math.min(lines.length - 1, index + CONTEXT)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && from <= last[1] + 1) {
      last[1] = Math.max(last[1], to)
    } else {
      ranges.push([from, to])
    }
  }

  // Line numbers at the start of each edit-script index.
  const oldAt: number[] = []
  const newAt: number[] = []
  let oldLine = 1
  let newLine = 1
  for (const line of lines) {
    oldAt.push(oldLine)
    newAt.push(newLine)
    if (line.op !== '+') oldLine++
    if (line.op !== '-') newLine++
  }

  return ranges.map(([from, to]) => {
    const slice = lines.slice(from, to + 1)
    const oldLines = slice.filter((line) => line.op !== '+').length
    const newLines = slice.filter((line) => line.op !== '-').length
    const oldStart = oldAt[from] as number
    const newStart = newAt[from] as number
    return {
      oldStart: oldLines === 0 ? oldStart - 1 : oldStart,
      oldLines,
      newStart: newLines === 0 ? newStart - 1 : newStart,
      newLines,
      lines: slice,
    }
  })
}

// The text `diff -u` would print for these hunks, headers included. Empty
// when there are no hunks, so "no differences" is an empty string.
export function renderUnified(oldLabel: string, newLabel: string, hunks: DiffHunk[]): string {
  if (hunks.length === 0) {
    return ''
  }
  const out = [`--- ${oldLabel}`, `+++ ${newLabel}`]
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      out.push(`${line.op}${line.text}`)
    }
  }
  return `${out.join('\n')}\n`
}
