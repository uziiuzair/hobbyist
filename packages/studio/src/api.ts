// The only place in Studio that knows an HTTP route exists. Every view goes
// through the functions here, never through a bare fetch() of its own, so
// there is exactly one place that has to agree with the daemon's contract.
//
// Studio holds no database credentials and opens no database connections:
// every one of these calls, including runQuery, is a request to the daemon
// over HTTP. That is what lets a query against a sleeping database wake it
// for free, see runQuery's comment below and the report for what that
// requires of the daemon.
//
// Type-only import: @hobby.sh/core also exports the Docker runtime and the
// sqlite-backed store (see packages/core/src/index.ts), both of which pull
// in node:child_process and node:sqlite. Importing only types keeps those
// modules out of the browser bundle entirely, verified by `npm run build`
// producing no such specifier in the output.
import type { Project, Resource } from "@hobby.sh/core";

export type ErrorCode =
  | "project_not_found"
  | "resource_not_found"
  | "name_taken"
  | "invalid_name"
  | "ambiguous_target"
  | "runtime_unavailable"
  | "wake_failed"
  | "wake_timeout"
  | "not_ready"
  | "conflict"
  | "usage"
  | "unauthorized"
  | "internal"
  // Studio-side fallback for a response that did not match the documented
  // envelope at all, for example a proxy error page or a network failure.
  | "unreachable";

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly status: number;

  constructor(code: ErrorCode, message: string, status: number, hint?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; hint?: string };
}

function looksLikeErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value))
    return false;
  const err = (value as { error: unknown }).error;
  return (
    typeof err === "object" && err !== null && "code" in err && "message" in err
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init?.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new ApiError(
      "unreachable",
      err instanceof Error ? err.message : String(err),
      0,
    );
  }

  const text = await res.text();
  const body: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

  if (!res.ok) {
    if (looksLikeErrorEnvelope(body)) {
      throw new ApiError(
        body.error.code,
        body.error.message,
        res.status,
        body.error.hint,
      );
    }
    throw new ApiError(
      "unreachable",
      `request failed with status ${res.status}`,
      res.status,
    );
  }

  return body as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function jsonBody(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

// --- Session (Task 10 contract, see the report for the assumption this rests on) ---

export function login(username: string, password: string): Promise<void> {
  return request("/studio/login", jsonBody({ username, password }));
}

export function logout(): Promise<void> {
  return request("/studio/logout", { method: "POST" });
}

export function session(): Promise<{ authenticated: boolean }> {
  return request("/studio/session");
}

// --- Host ---

export interface Preflight {
  runtimeAvailable: boolean;
  filesystem: { path: string; reflinkSupported: boolean; freeBytes: number };
  ports: {
    proxy: { port: number; bound: boolean };
    studio: { port: number; bound: boolean };
  };
}

// Read only, and the daemon guarantees it mutates nothing, so Studio can poll
// it for the capacity panel. It is the closest thing to a plan quota that is
// actually true on a machine you own. Note it carries no memory figure: the
// panel shows disk and awake count rather than estimating RAM.
export function preflight(): Promise<Preflight> {
  return request("/v1/preflight");
}

// --- Projects ---

export function listProjects(): Promise<{ projects: Project[] }> {
  return request("/v1/projects");
}

export function createProject(name: string): Promise<{ project: Project }> {
  return request("/v1/projects", jsonBody({ name }));
}

export function getProject(
  name: string,
): Promise<{ project: Project; resources: Resource[] }> {
  return request(`/v1/projects/${encodeURIComponent(name)}`);
}

export function deleteProject(
  name: string,
  opts?: { force?: boolean },
): Promise<{ deleted: true }> {
  const qs = opts?.force === true ? "?force=true" : "";
  return request(`/v1/projects/${encodeURIComponent(name)}${qs}`, {
    method: "DELETE",
  });
}

// --- Resources ---

export function createResource(
  projectName: string,
  name: string,
): Promise<{ resource: Resource }> {
  return request(
    `/v1/projects/${encodeURIComponent(projectName)}/resources`,
    jsonBody({ kind: "postgres", name }),
  );
}

export function getResource(id: string): Promise<{ resource: Resource }> {
  return request(`/v1/resources/${encodeURIComponent(id)}`);
}

export function destroyResource(id: string): Promise<{ deleted: true }> {
  return request(`/v1/resources/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// The daemon's mechanical verbs are start/stop; Studio renders them as the
// wake/sleep language the rest of the product uses, same as the CLI does
// (see docs/cli/specs/2026-08-07-m1-daemon-control-api-and-verbs.md).
export function wakeResource(id: string): Promise<{ resource: Resource }> {
  return request(`/v1/resources/${encodeURIComponent(id)}/start`, {
    method: "POST",
  });
}

export function sleepResource(id: string): Promise<{ resource: Resource }> {
  return request(`/v1/resources/${encodeURIComponent(id)}/stop`, {
    method: "POST",
  });
}

export function connectionString(
  id: string,
): Promise<{ connectionString: string }> {
  return request(`/v1/resources/${encodeURIComponent(id)}/connection`);
}

export function logs(id: string, tail = 200): Promise<{ logs: string }> {
  return request(`/v1/resources/${encodeURIComponent(id)}/logs?tail=${tail}`);
}

export function eject(
  projectName: string,
): Promise<{ compose: string; dataDirs: string[] }> {
  return request(`/v1/projects/${encodeURIComponent(projectName)}/eject`, {
    method: "POST",
  });
}

// --- Deploy ---

// Only an app or a worker can be deployed; the daemon refuses any other kind
// with a `usage` error rather than a 404, so the caller learns which kind it
// actually addressed. `ignored` lists paths the build skipped.
export interface DeployResult {
  resource: Resource;
  image: string;
  logs: string;
  ignored?: string[];
}

export function deployResource(
  id: string,
  source?: { path: string },
): Promise<DeployResult> {
  return request(
    `/v1/resources/${encodeURIComponent(id)}/deploy`,
    jsonBody(source ?? {}),
  );
}

// --- Queues ---

// The queue list is project scoped, unlike every other queue route: depth and
// consumer are joins across the project's resources, so the daemon computes
// them in one pass rather than making Studio fan out per queue.
export interface QueueEntry {
  resource: Resource;
  depth: number;
  oldestMessageAgeSeconds: number | null;
  consumer: Resource | null;
}

export interface QueueMessage {
  id: string;
  timestampMs: number;
  attempts: number;
  contentType: string;
  body: unknown;
}

export function listQueues(
  projectName: string,
): Promise<{ queues: QueueEntry[] }> {
  return request(`/v1/projects/${encodeURIComponent(projectName)}/queues`);
}

// Non-destructive. peek() never touches lease_id, so a message read here is
// still exactly as deliverable afterwards as it was before.
export function peekQueue(
  id: string,
  limit?: number,
): Promise<{ messages: QueueMessage[] }> {
  const qs = limit === undefined ? "" : `?limit=${limit}`;
  return request(
    `/v1/resources/${encodeURIComponent(id)}/queue/messages${qs}`,
  );
}

// `body` is the value itself, not a pre-encoded string: the daemon runs the
// codec once, so no caller needs to know the queue's wire format.
export function sendQueueMessage(
  id: string,
  body: unknown,
  delaySeconds?: number,
): Promise<{ id: string }> {
  return request(
    `/v1/resources/${encodeURIComponent(id)}/queue/messages`,
    jsonBody({ body, delaySeconds }),
  );
}

export function purgeQueue(id: string): Promise<{ purged: number }> {
  return request(`/v1/resources/${encodeURIComponent(id)}/queue/messages`, {
    method: "DELETE",
  });
}

// Rejected outright outside Cloudflare's own bounds (60 seconds to 14 days),
// never clamped, so a value you think you set is a value that was set.
export function setQueueRetention(
  id: string,
  retentionSeconds: number,
): Promise<{ resource: Resource }> {
  return request(
    `/v1/resources/${encodeURIComponent(id)}/queue/retention`,
    jsonBody({ retentionSeconds }),
  );
}

// --- Query ---
//
// POST /v1/resources/:id/query now exists (packages/cli/src/daemon/routes.ts,
// dispatch's `action === 'query'` branch). Sql, Tables and Schema are all
// built against this one call.

export interface QueryColumn {
  name: string;
  dataType: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  command: string;
}

export function runQuery(
  resourceId: string,
  sql: string,
  params?: unknown[],
): Promise<QueryResult> {
  return request(
    `/v1/resources/${encodeURIComponent(resourceId)}/query`,
    jsonBody({ sql, params }),
  );
}
