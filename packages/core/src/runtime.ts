// The compute runtime interface and its in-memory fake. Real implementations
// (Docker today, a microVM later, see docs/decisions/0002) live outside
// core: this file only describes the contract and gives every later task's
// test suite something to run against without Docker.

export type ContainerId = string

export interface ContainerSpec {
  name: string
  image: string
  env: Record<string, string>
  ports: Array<{ host: number; container: number }>
  binds: Array<{ host: string; container: string }>
  network?: string
}

export interface ContainerStatus {
  exists: boolean
  running: boolean
  exitCode: number | null
}

export interface ComputeRuntime {
  available(): Promise<boolean>
  ensureCreated(spec: ContainerSpec): Promise<ContainerId>
  start(name: string): Promise<void>
  stop(name: string, opts: { timeoutSec: number }): Promise<void>
  remove(name: string): Promise<void>
  inspect(name: string): Promise<ContainerStatus>
  logs(name: string, opts: { tail: number }): Promise<string>
  ensureNetwork(name: string): Promise<void>
  removeNetwork(name: string): Promise<void>
}

const NOT_FOUND_STATUS: ContainerStatus = { exists: false, running: false, exitCode: null }

export function createFakeRuntime(): ComputeRuntime & {
  _state: Map<string, ContainerStatus>
  _specs: Map<string, ContainerSpec>
} {
  const state = new Map<string, ContainerStatus>()
  const specs = new Map<string, ContainerSpec>()
  const networks = new Set<string>()

  return {
    _state: state,
    _specs: specs,

    async available(): Promise<boolean> {
      return true
    },

    async ensureCreated(spec: ContainerSpec): Promise<ContainerId> {
      specs.set(spec.name, spec)
      if (!state.has(spec.name)) {
        state.set(spec.name, { exists: true, running: false, exitCode: null })
      }
      return spec.name
    },

    async start(name: string): Promise<void> {
      const current = state.get(name) ?? { exists: true, running: false, exitCode: null }
      state.set(name, { ...current, exists: true, running: true, exitCode: null })
    },

    async stop(name: string, _opts: { timeoutSec: number }): Promise<void> {
      const current = state.get(name) ?? { exists: true, running: false, exitCode: null }
      state.set(name, { ...current, running: false, exitCode: 0 })
    },

    async remove(name: string): Promise<void> {
      state.delete(name)
      specs.delete(name)
    },

    async inspect(name: string): Promise<ContainerStatus> {
      return state.get(name) ?? NOT_FOUND_STATUS
    },

    async logs(_name: string, _opts: { tail: number }): Promise<string> {
      return ''
    },

    async ensureNetwork(name: string): Promise<void> {
      networks.add(name)
    },

    async removeNetwork(name: string): Promise<void> {
      networks.delete(name)
    },
  }
}
