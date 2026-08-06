// The state store: one sqlite file per daemon, holding projects and
// resources. Uses node:sqlite (built into Node, no native build step) rather
// than better-sqlite3. It is synchronous on purpose: the daemon is a single
// process and sqlite writes are fast, so there is nothing an async wrapper
// would buy here. Importing node:sqlite emits an ExperimentalWarning; that is
// expected and not suppressed.

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { HobbyError } from './errors.js'
import type {
  PostgresConfig,
  Project,
  ProjectId,
  Resource,
  ResourceId,
  ResourceKind,
  ResourceState,
} from './types.js'

export interface Store {
  createProject(input: { name: string; sleepAfterSeconds: number | null }): Project
  getProject(id: ProjectId): Project | null
  getProjectByName(name: string): Project | null
  listProjects(): Project[]
  deleteProject(id: ProjectId): void
  createResource(input: {
    projectId: ProjectId
    kind: ResourceKind
    name: string
    config: PostgresConfig
  }): Resource
  getResource(id: ResourceId): Resource | null
  getResourceByName(projectId: ProjectId, name: string): Resource | null
  listResources(projectId?: ProjectId): Resource[]
  setResourceState(id: ResourceId, state: ResourceState): void
  touchResource(id: ResourceId, at: Date): void
  updateResourceConfig(id: ResourceId, config: PostgresConfig): void
  deleteResource(id: ResourceId): void
  allocatePort(from: number, to: number): number
  close(): void
}

interface ProjectRow {
  id: string
  name: string
  network_name: string
  sleep_after_seconds: number | null
  created_at: string
}

interface ResourceRow {
  id: string
  project_id: string
  kind: string
  name: string
  state: string
  config: string
  last_active_at: string | null
  created_at: string
}

interface ConfigRow {
  config: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  network_name TEXT NOT NULL,
  sleep_after_seconds INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  config TEXT NOT NULL,
  last_active_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
`

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    networkName: row.network_name,
    sleepAfterSeconds: row.sleep_after_seconds,
    createdAt: new Date(row.created_at),
  }
}

function rowToResource(row: ResourceRow): Resource {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as ResourceKind,
    name: row.name,
    state: row.state as ResourceState,
    config: JSON.parse(row.config) as PostgresConfig,
    lastActiveAt: row.last_active_at === null ? null : new Date(row.last_active_at),
    createdAt: new Date(row.created_at),
  }
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)

  function getProject(id: ProjectId): Project | null {
    const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
      | ProjectRow
      | undefined
    return row === undefined ? null : rowToProject(row)
  }

  function getProjectByName(name: string): Project | null {
    const row = db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as
      | ProjectRow
      | undefined
    return row === undefined ? null : rowToProject(row)
  }

  function getResource(id: ResourceId): Resource | null {
    const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as
      | ResourceRow
      | undefined
    return row === undefined ? null : rowToResource(row)
  }

  function getResourceByName(projectId: ProjectId, name: string): Resource | null {
    const row = db
      .prepare('SELECT * FROM resources WHERE project_id = ? AND name = ?')
      .get(projectId, name) as ResourceRow | undefined
    return row === undefined ? null : rowToResource(row)
  }

  return {
    createProject(input: { name: string; sleepAfterSeconds: number | null }): Project {
      // Checked here rather than relying on the UNIQUE constraint's raised error, so callers
      // always see a HobbyError. Safe today because the daemon is single-process and this
      // check-then-insert is not interleaved with any other write to the same row; if
      // concurrent writers are ever introduced, this needs a real transaction or the
      // constraint violation needs to be caught and translated instead.
      if (getProjectByName(input.name) !== null) {
        throw new HobbyError('name_taken', `project name already taken: ${input.name}`)
      }
      const id = randomUUID()
      const createdAt = new Date()
      const networkName = `hobby-${input.name}`
      db.prepare(
        'INSERT INTO projects (id, name, network_name, sleep_after_seconds, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, input.name, networkName, input.sleepAfterSeconds, createdAt.toISOString())
      return {
        id,
        name: input.name,
        networkName,
        sleepAfterSeconds: input.sleepAfterSeconds,
        createdAt,
      }
    },

    getProject,
    getProjectByName,

    listProjects(): Project[] {
      const rows = db
        .prepare('SELECT * FROM projects ORDER BY created_at')
        .all() as unknown as ProjectRow[]
      return rows.map(rowToProject)
    },

    deleteProject(id: ProjectId): void {
      db.prepare('DELETE FROM resources WHERE project_id = ?').run(id)
      db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    },

    createResource(input: {
      projectId: ProjectId
      kind: ResourceKind
      name: string
      config: PostgresConfig
    }): Resource {
      // Same check-then-insert reasoning as createProject above: deliberate application-level
      // backstop for the UNIQUE(project_id, name) constraint, not a substitute for a
      // transaction if concurrent writers are ever added.
      if (getResourceByName(input.projectId, input.name) !== null) {
        throw new HobbyError('name_taken', `resource name already taken: ${input.name}`)
      }
      const id = randomUUID()
      const createdAt = new Date()
      const state: ResourceState = 'creating'
      db.prepare(
        'INSERT INTO resources (id, project_id, kind, name, state, config, last_active_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        id,
        input.projectId,
        input.kind,
        input.name,
        state,
        JSON.stringify(input.config),
        null,
        createdAt.toISOString()
      )
      return {
        id,
        projectId: input.projectId,
        kind: input.kind,
        name: input.name,
        state,
        config: input.config,
        lastActiveAt: null,
        createdAt,
      }
    },

    getResource,
    getResourceByName,

    listResources(projectId?: ProjectId): Resource[] {
      const rows = (
        projectId === undefined
          ? db.prepare('SELECT * FROM resources ORDER BY created_at').all()
          : db.prepare('SELECT * FROM resources WHERE project_id = ? ORDER BY created_at').all(projectId)
      ) as unknown as ResourceRow[]
      return rows.map(rowToResource)
    },

    setResourceState(id: ResourceId, state: ResourceState): void {
      db.prepare('UPDATE resources SET state = ? WHERE id = ?').run(state, id)
    },

    touchResource(id: ResourceId, at: Date): void {
      db.prepare('UPDATE resources SET last_active_at = ? WHERE id = ?').run(at.toISOString(), id)
    },

    updateResourceConfig(id: ResourceId, config: PostgresConfig): void {
      db.prepare('UPDATE resources SET config = ? WHERE id = ?').run(JSON.stringify(config), id)
    },

    deleteResource(id: ResourceId): void {
      db.prepare('DELETE FROM resources WHERE id = ?').run(id)
    },

    allocatePort(from: number, to: number): number {
      const rows = db.prepare('SELECT config FROM resources').all() as unknown as ConfigRow[]
      const taken = new Set<number>()
      for (const row of rows) {
        const config = JSON.parse(row.config) as PostgresConfig
        taken.add(config.hostPort)
      }
      for (let port = from; port <= to; port++) {
        if (!taken.has(port)) return port
      }
      throw new HobbyError('conflict', `no free port in range ${from}-${to}`)
    },

    close(): void {
      db.close()
    },
  }
}
