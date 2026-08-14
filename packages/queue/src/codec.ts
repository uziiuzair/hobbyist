// A structured-clone compatible codec, so a queued body means the same thing
// on the way out as it did on the way in.
//
// The daemon never calls this. It stores the string and never parses it: the
// broker's job is to hold bytes durably, not to understand them. Both ends
// that DO call it are inside a container, and Task 12 embeds this file's
// source verbatim into the runner, which is why it imports nothing.
//
// The format is a flat array of tagged nodes. Index 0 is the root, and every
// reference is an index into the same array, which is what makes cycles and
// shared references work: a graph, not a tree.

type Node =
  | ['prim', string | number | boolean | null]
  | ['undef']
  | ['big', string]
  | ['date', number]
  | ['regexp', string, string]
  | ['array', number[]]
  | ['object', Array<[string, number]>]
  | ['map', Array<[number, number]>]
  | ['set', number[]]

export function encodeBody(value: unknown): string {
  const nodes: Node[] = []
  const seen = new Map<unknown, number>()

  function write(input: unknown): number {
    if (input === undefined) {
      nodes.push(['undef'])
      return nodes.length - 1
    }
    if (input === null || typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
      nodes.push(['prim', input])
      return nodes.length - 1
    }
    if (typeof input === 'bigint') {
      nodes.push(['big', input.toString()])
      return nodes.length - 1
    }

    const existing = seen.get(input)
    if (existing !== undefined) {
      return existing
    }

    if (input instanceof Date) {
      nodes.push(['date', input.getTime()])
      const index = nodes.length - 1
      seen.set(input, index)
      return index
    }
    if (input instanceof RegExp) {
      nodes.push(['regexp', input.source, input.flags])
      const index = nodes.length - 1
      seen.set(input, index)
      return index
    }

    // The slot is reserved BEFORE the children are written, so a child that
    // refers back to this node finds an index rather than recursing forever.
    if (Array.isArray(input)) {
      const node: Node = ['array', []]
      nodes.push(node)
      const index = nodes.length - 1
      seen.set(input, index)
      for (const item of input) {
        node[1].push(write(item))
      }
      return index
    }
    if (input instanceof Map) {
      const node: Node = ['map', []]
      nodes.push(node)
      const index = nodes.length - 1
      seen.set(input, index)
      for (const [key, item] of input) {
        node[1].push([write(key), write(item)])
      }
      return index
    }
    if (input instanceof Set) {
      const node: Node = ['set', []]
      nodes.push(node)
      const index = nodes.length - 1
      seen.set(input, index)
      for (const item of input) {
        node[1].push(write(item))
      }
      return index
    }

    const node: Node = ['object', []]
    nodes.push(node)
    const index = nodes.length - 1
    seen.set(input, index)
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      node[1].push([key, write(item)])
    }
    return index
  }

  write(value)
  return JSON.stringify(nodes)
}

export function decodeBody(text: string): unknown {
  const nodes = JSON.parse(text) as Node[]
  const built = new Array<unknown>(nodes.length)
  const done = new Array<boolean>(nodes.length).fill(false)

  // Two passes for the same reason encode reserves slots: a container has to
  // exist before its children can point at it.
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node === undefined) continue
    switch (node[0]) {
      case 'prim':
        built[i] = node[1]
        done[i] = true
        break
      case 'undef':
        built[i] = undefined
        done[i] = true
        break
      case 'big':
        built[i] = BigInt(node[1])
        done[i] = true
        break
      case 'date':
        built[i] = new Date(node[1])
        done[i] = true
        break
      case 'regexp':
        built[i] = new RegExp(node[1], node[2])
        done[i] = true
        break
      case 'array':
        built[i] = []
        break
      case 'object':
        built[i] = {}
        break
      case 'map':
        built[i] = new Map<unknown, unknown>()
        break
      case 'set':
        built[i] = new Set<unknown>()
        break
    }
  }

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node === undefined || done[i] === true) continue
    if (node[0] === 'array') {
      const target = built[i] as unknown[]
      for (const ref of node[1]) target.push(built[ref])
    } else if (node[0] === 'object') {
      const target = built[i] as Record<string, unknown>
      for (const [key, ref] of node[1]) target[key] = built[ref]
    } else if (node[0] === 'map') {
      const target = built[i] as Map<unknown, unknown>
      for (const [keyRef, valueRef] of node[1]) target.set(built[keyRef], built[valueRef])
    } else if (node[0] === 'set') {
      const target = built[i] as Set<unknown>
      for (const ref of node[1]) target.add(built[ref])
    }
  }

  return built[0]
}
