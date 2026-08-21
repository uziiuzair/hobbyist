/**
 * The feature map
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import type { ResourceKind } from "@hobby.sh/core";

/**
 * One list of everything Studio will eventually hold, in the order the rail
 * shows it. The rail renders this, the coming soon page reads this, and the
 * router resolves against this, so a feature can only ever appear in all
 * three places or none.
 *
 * A rail that only shows what is finished tells you what Studio does. A rail
 * that shows the whole map tells you what Hobbyist is, which is the more
 * useful thing to know when you are deciding whether to depend on it. The
 * cost of showing unbuilt destinations is that a reader could mistake one for
 * a working page, so every entry carries a status and every status that is
 * not `ready` is stated on the row and again on the page it opens. Nothing is
 * listed here that is not in CLAUDE.md's phase table: the rail is a mirror of
 * the roadmap, never a wishlist that grew its own scope.
 */
export type NavStatus =
  // Built and usable now.
  | "ready"
  // Real data behind it, but the page only lists: no detail view, and some
  // facts the equivalent managed dashboard would show are not readable here.
  | "preview"
  // Nothing is built. The page says so and points at whatever does work today.
  | "soon";

export interface NavItem {
  /** Route segment under `#/projects/:name/`. */
  id: string;
  label: string;
  status: NavStatus;
  /** Set when the page lists resources of exactly one kind. */
  kind?: ResourceKind;
  /** What the finished feature does. Present tense, one sentence. */
  blurb: string;
  /**
   * What exists on this machine today. A route, a command, or the plain
   * admission that there is nothing. Never a promise: the repo rule is that a
   * reader must never execute an aspiration.
   */
  today: string;
  /** Where CLAUDE.md's phase table puts it. */
  phase: string;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
}

export const PROJECT_NAV: NavGroup[] = [
  {
    id: "compute",
    label: "Compute",
    items: [
      {
        id: "apps",
        label: "Apps",
        status: "preview",
        kind: "app",
        blurb:
          "Long running containers of any runtime, woken by the HTTP router on the first request.",
        today:
          "The daemon builds, deploys, wakes and sleeps apps. Studio lists them; there is no per app page.",
        phase: "Phase 2",
      },
      {
        id: "workers",
        label: "Workers",
        status: "preview",
        kind: "worker",
        blurb:
          "Request handlers on workerd, deployed from a wrangler manifest, asleep between requests.",
        today:
          "The daemon builds, deploys, wakes and sleeps workers. Studio lists them; there is no per worker page, so deploys and logs are CLI only.",
        phase: "Phase 2",
      },
      {
        id: "durable-objects",
        label: "Durable Objects",
        status: "preview",
        blurb:
          "Single instance stateful objects with their own SQLite storage and alarms that survive a sleep.",
        today:
          "Namespaces are read from each worker's deployed manifest. The daemon publishes no route over object storage, so instance counts, sizes and alarm deadlines cannot be shown here.",
        phase: "Phase 2",
      },
      {
        id: "queues",
        label: "Queues",
        status: "ready",
        kind: "queue",
        blurb:
          "Durable message queues that hold a backlog while their consumer sleeps, and wake it to drain.",
        today:
          "Built. Depth, oldest message age, peek, send, purge and retention.",
        phase: "Phase 2",
      },
    ],
  },
  {
    id: "storage",
    label: "Storage",
    items: [
      {
        id: "databases",
        label: "Databases",
        status: "ready",
        kind: "postgres",
        blurb:
          "Postgres instances that sleep when nothing is connected and wake on the first query.",
        today:
          "Built. Tables, SQL and schema views, connection strings, import and export.",
        phase: "Phase 1",
      },
      {
        id: "d1",
        label: "D1",
        status: "soon",
        blurb:
          "SQLite databases a worker binds and queries, with a browser for their tables.",
        today:
          "A worker can already bind one: Miniflare provides the D1 API inside the runtime (ADR 0011), and `d1Databases` is read off the wrangler manifest. The daemon does not manage them as resources, so nothing here can list, query or size them.",
        phase: "Phase 2",
      },
      {
        id: "kv",
        label: "KV",
        status: "soon",
        blurb: "Key value namespaces a worker reads and writes.",
        today:
          "Same as D1: Miniflare provides the API inside the runtime and `kvNamespaces` is read off the manifest, but the daemon owns no route over the keys.",
        phase: "Phase 2",
      },
      {
        id: "object-storage",
        label: "Object storage",
        status: "soon",
        blurb:
          "S3 compatible buckets on your own disk, addressable from workers and apps.",
        today:
          "Nothing on the daemon side: `docs/storage/specs` is empty. A worker's R2 bindings run inside Miniflare and are invisible from here.",
        phase: "Phase 3",
      },
      {
        id: "volumes",
        label: "Volumes",
        status: "soon",
        blurb:
          "Persistent disks attached to compute, so an app can hold state that is not a database.",
        today:
          "Nothing. Phase 2 compute is deliberately stateless and gets its persistence from Postgres.",
        phase: "Phase 3",
      },
      {
        id: "branches",
        label: "Branches",
        status: "soon",
        blurb:
          "Copy on write clones of a database, made in the time it takes to reflink a data directory.",
        today:
          "Nothing. `docs/branching/specs` is empty and no daemon route exists. `hobby init` already detects whether the filesystem supports reflinks, which is what this will need.",
        phase: "Phase 1.5",
      },
      {
        id: "backups",
        label: "Backups",
        status: "soon",
        blurb:
          "Whole project snapshots, taken with every resource quiesced, and restored into a new project.",
        today:
          "The engine is built and tested (packages/cli/src/daemon/snapshots.ts, plus 28 tests) and ADR 0016 settles its shape, including that there is deliberately no point in time recovery. Nothing calls it: no daemon route, no CLI command, so it cannot be run from here or from the terminal yet. Export on the project page runs a `pg_dump` you drive yourself, and that keeps working whatever happens here.",
        phase: "Not phased",
      },
    ],
  },
  {
    id: "observe",
    label: "Observe",
    items: [
      {
        id: "logs",
        label: "Logs",
        status: "soon",
        blurb:
          "Container output for every resource in the project, in one place, without an SSH session.",
        today:
          "`GET /v1/resources/:id/logs` returns the tail today and `hobby logs` prints it. No Studio view reads it yet.",
        phase: "Phase 1",
      },
      {
        id: "metrics",
        label: "Metrics",
        status: "soon",
        blurb:
          "Connections, wake counts and cold start times over a window longer than the tab has been open.",
        today:
          "The activity chart on the project page samples while the page is open and keeps nothing. Nothing on the box writes a metrics history, so there is no past to show.",
        phase: "Not phased",
      },
    ],
  },
  {
    id: "connect",
    label: "Connect",
    items: [
      {
        id: "domains",
        label: "Domains and TLS",
        status: "soon",
        blurb:
          "Hostnames routed to apps and workers, with certificates issued on demand.",
        today:
          "Caddy is the decided front door (ADR 0009) and `createCaddyManager` exists, but nothing calls it. The HTTP wake router works on its own port.",
        phase: "Phase 2",
      },
    ],
  },
  {
    id: "manage",
    label: "Manage",
    items: [
      {
        id: "settings",
        label: "Settings",
        status: "soon",
        blurb:
          "The sleep timer, pinning a project awake, and renaming or deleting it.",
        today:
          "The sleep timer is shown under the project name and set in config. Deleting a project works from the projects list.",
        phase: "Phase 1",
      },
      {
        id: "eject",
        label: "Eject",
        status: "soon",
        blurb:
          "A docker-compose.yml and your data directory, handed over so Hobbyist can be removed.",
        today:
          "`hobby eject <project>` works now and prints the compose file to stdout. The route behind it is a read and changes nothing.",
        phase: "Not phased",
      },
    ],
  },
];

export const ACCOUNT_NAV: NavGroup[] = [
  {
    id: "organisation",
    label: "Organisation",
    items: [
      {
        id: "",
        label: "Projects",
        status: "ready",
        blurb: "Every project on this box.",
        today: "Built.",
        phase: "Phase 1",
      },
      {
        id: "machine",
        label: "Machine",
        status: "soon",
        blurb:
          "The box itself: disk, filesystem capabilities, daemon version, and what is awake right now.",
        today:
          "`GET /v1/preflight` reports free bytes and whether the filesystem supports reflinks. The strip on the projects page shows part of it.",
        phase: "Phase 1",
      },
      {
        id: "mcp",
        label: "MCP",
        status: "soon",
        blurb:
          "The tools an agent gets over the daemon API, and which ones are enabled.",
        today:
          "`@hobby.sh/mcp` exists and speaks to the same daemon API Studio uses. Nothing configures it from here.",
        phase: "Phase 1",
      },
    ],
  },
];

/** Every project scoped item, flattened, for the router. */
export const PROJECT_ITEMS: NavItem[] = PROJECT_NAV.flatMap(
  (group) => group.items,
);

export function findProjectItem(id: string | undefined): NavItem | undefined {
  if (id === undefined) return undefined;
  return PROJECT_ITEMS.find((item) => item.id === id);
}

export function findAccountItem(id: string | undefined): NavItem | undefined {
  if (id === undefined) return undefined;
  return ACCOUNT_NAV.flatMap((group) => group.items).find(
    (item) => item.id === id,
  );
}

/** The word the rail and the page put on a row that is not finished. */
export function statusLabel(status: NavStatus): string | null {
  if (status === "preview") return "Preview";
  if (status === "soon") return "Soon";
  return null;
}
