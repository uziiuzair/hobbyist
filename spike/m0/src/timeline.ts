export class Timeline {
  private marks = new Map<string, bigint>()

  constructor(private readonly now: () => bigint = () => process.hrtime.bigint()) {}

  mark(name: string): void {
    if (this.marks.has(name)) throw new Error(`duplicate mark "${name}"`)
    this.marks.set(name, this.now())
  }

  segmentMs(from: string, to: string): number {
    const a = this.marks.get(from)
    const b = this.marks.get(to)
    if (a === undefined) throw new Error(`no mark named "${from}"`)
    if (b === undefined) throw new Error(`no mark named "${to}"`)
    return Number(b - a) / 1_000_000
  }

  has(name: string): boolean {
    return this.marks.has(name)
  }
}
