// The state store: one sqlite file per daemon, holding projects and
// resources. It is synchronous on purpose: the daemon is a single process and
// sqlite writes are fast, so there is nothing an async wrapper would buy here.
//
// Which sqlite is behind openDatabase depends on the runtime, and this file
// deliberately does not know: see sqlite.ts, which is also where the one
// behavioural difference between the two (what a row miss returns) is
// normalised away. Under Node that is node:sqlite, built in, no native build
// step, and its import emits an ExperimentalWarning that is expected and not
// suppressed.

import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync } from 'node:fs'
import { openDatabase, type SqliteDatabase } from './sqlite.js'
import { HobbyError } from './errors.js'
import type {
  Project,
  ProjectId,
  Resource,
  ResourceConfig,
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
  setProjectReleased(id: ProjectId, at: Date | null): void
  setProjectSleepAfterSeconds(id: ProjectId, sleepAfterSeconds: number | null): void
  createResource(input: {
    projectId: ProjectId
    kind: ResourceKind
    name: string
    config: ResourceConfig
  }): Resource
  getResource(id: ResourceId): Resource | null
  getResourceByName(projectId: ProjectId, name: string): Resource | null
  listResources(projectId?: ProjectId): Resource[]
  setResourceState(id: ResourceId, state: ResourceState): void
  touchResource(id: ResourceId, at: Date): void
  updateResourceConfig(id: ResourceId, config: ResourceConfig): void
  deleteResource(id: ResourceId): void
  allocatePort(from: number, to: number, exclude?: number[]): number
  close(): void
}

interface ProjectRow {
  id: string
  name: string
  network_name: string
  sleep_after_seconds: number | null
  created_at: string
  released_at: string | null
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
  created_at TEXT NOT NULL,
  released_at TEXT
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
    releasedAt: row.released_at === null || row.released_at === undefined ? null : new Date(row.released_at),
  }
}

// The one place a stored row becomes a typed Resource, and therefore the one
// place the discriminated union in types.ts is asserted rather than proven.
// sqlite hands back a `kind` string and a `config` JSON blob; nothing at this
// boundary can check that a row tagged 'worker' really holds a WorkerConfig.
// The invariant is upheld on the way in (createResource takes a
// ResourceConfig and the kind that goes with it) and asserted here on the way
// out, which is the same shape of trust every row-to-object mapper makes.
function rowToResource(row: ResourceRow): Resource {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as ResourceKind,
    name: row.name,
    state: row.state as ResourceState,
    config: JSON.parse(row.config) as ResourceConfig,
    lastActiveAt: row.last_active_at === null ? null : new Date(row.last_active_at),
    createdAt: new Date(row.created_at),
  } as Resource
}

// Owner-only. Every resource row's `config` column is plaintext JSON
// holding that database's superuser password (see PostgresConfig.password),
// and sqlite creates its files 0644, which makes every password on the box
// readable by every local user. Same reasoning that already gives the
// daemon socket and the studio credential file 0600. The -wal and -shm
// sidecars carry the same rows in flight, so they get the same mode; both
// exist by the time this runs, because the schema exec above has already
// written through the WAL.
const STATE_FILE_MODE = 0o600

function restrictStateFiles(path: string): void {
  // ':memory:' (every test's store) is not a file at all, and neither are
  // sqlite's other special names; chmod on them would throw ENOENT.
  if (path === ':memory:' || path === '') {
    return
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (existsSync(file)) {
      chmodSync(file, STATE_FILE_MODE)
    }
  }
}

// CREATE TABLE IF NOT EXISTS creates a new database correctly and does nothing
// at all to one that already exists, so every column added after the first
// release needs a statement of its own. There is no migration framework here
// on purpose: this is one process opening one file, and the entire history is
// a handful of ALTERs that each have to be idempotent.
//
// Idempotent by asking sqlite what the table looks like rather than by
// catching the duplicate-column error, so a genuine failure is not swallowed
// along with the expected one.
function migrate(db: SqliteDatabase): void {
  const columns = db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'released_at')) {
    db.exec('ALTER TABLE projects ADD COLUMN released_at TEXT')
  }
}

export function openStore(path: string): Store {
  const db = openDatabase(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)
  migrate(db)
  restrictStateFiles(path)

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
        releasedAt: null,
      }
    },

    // Both directions: a Date hands the project over, null takes it back
    // (`hobby adopt`). Nothing else about the project changes either way,
    // which is the point: the rows, the config, the credentials and the data
    // directory are all still here, and only whether hobby acts on them moves.
    setProjectReleased(id: ProjectId, at: Date | null): void {
      db.prepare('UPDATE projects SET released_at = ? WHERE id = ?').run(at === null ? null : at.toISOString(), id)
    },

    // The per-project sleep policy. Null pins the project awake: the
    // hibernator checks it before anything else (packages/cli/src/daemon/
    // hibernator.ts) and never puts a pinned project's resources to sleep.
    // A number is this project's own idle threshold, overriding the
    // box-wide config default it was created with.
    setProjectSleepAfterSeconds(id: ProjectId, sleepAfterSeconds: number | null): void {
      db.prepare('UPDATE projects SET sleep_after_seconds = ? WHERE id = ?').run(sleepAfterSeconds, id)
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
      config: ResourceConfig
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
      // Same assertion as rowToResource, for the same reason: the caller
      // supplies a (kind, config) pair and TypeScript cannot check that they
      // agree from inside a function that accepts every kind.
      return {
        id,
        projectId: input.projectId,
        kind: input.kind,
        name: input.name,
        state,
        config: input.config,
        lastActiveAt: null,
        createdAt,
      } as Resource
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

    updateResourceConfig(id: ResourceId, config: ResourceConfig): void {
      db.prepare('UPDATE resources SET config = ? WHERE id = ?').run(JSON.stringify(config), id)
    },

    deleteResource(id: ResourceId): void {
      db.prepare('DELETE FROM resources WHERE id = ?').run(id)
    },

    // Every kind allocates a host port today (they all extend
    // ResourceConfigBase), so the guard below is defensive rather than
    // load-bearing. It is here because the previous version read
    // `config.hostPort` off every row unconditionally, which was correct
    // while one kind existed and would have silently added `undefined` to
    // the taken set the first time a kind without a port appeared, handing
    // two resources the same port with no error anywhere.
    // `exclude` is for a caller allocating more than one port for the same
    // not-yet-created resource in one breath (the worker kind's controlPort
    // alongside its hostPort): the second call cannot see the first call's
    // answer in the store yet, because nothing has been written, so without
    // this the two calls would hand back the same free port twice.
    allocatePort(from: number, to: number, exclude: number[] = []): number {
      const rows = db.prepare('SELECT config FROM resources').all() as unknown as ConfigRow[]
      const taken = new Set<number>(exclude)
      for (const row of rows) {
        const config = JSON.parse(row.config) as Partial<ResourceConfig>
        if (typeof config.hostPort === 'number') {
          taken.add(config.hostPort)
        }
        // WorkerConfig's controlPort is a second port on the same resource,
        // stored under a field name allocatePort does not otherwise know
        // about. Without tracking it here too, a later call (for anyone's
        // hostPort or controlPort) could hand out a number this resource
        // already holds.
        const controlPort = (config as { controlPort?: unknown }).controlPort
        if (typeof controlPort === 'number') {
          taken.add(controlPort)
        }
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
