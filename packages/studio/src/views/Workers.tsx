/**
 * Workers List
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import { formatSince, readStats } from "../lib/format.js";
import { useProjectResources } from "../lib/useProjectResources.js";
import { findProjectItem } from "../nav.js";
import { State } from "../components/State.js";
import { ResourcePage, EmptyList } from "../components/ResourcePage.js";
import { Table } from "../components/reusable/table.js";
import type { Column } from "../components/reusable/table.js";
import type { WorkerResource } from "@hobby.sh/core";

const ITEM = findProjectItem("workers")!;

// What a worker is bound to, counted rather than listed: the bindings column
// answers "is this wired to anything" in one glance, and the full list belongs
// on a per worker page that does not exist yet.
function bindings(row: WorkerResource): string {
  const manifest = row.config.manifest;
  if (manifest === null) return "--";
  const parts: string[] = [];
  if (manifest.durableObjects.length > 0)
    parts.push(`${manifest.durableObjects.length} DO`);
  if (manifest.queues.consumers.length > 0)
    parts.push(`${manifest.queues.consumers.length} queue consumer`);
  if (manifest.queues.producers.length > 0)
    parts.push(`${manifest.queues.producers.length} queue producer`);
  if (manifest.kvNamespaces.length > 0)
    parts.push(`${manifest.kvNamespaces.length} KV`);
  if (manifest.r2Buckets.length > 0)
    parts.push(`${manifest.r2Buckets.length} R2`);
  if (manifest.d1Databases.length > 0)
    parts.push(`${manifest.d1Databases.length} D1`);
  return parts.length === 0 ? "None" : parts.join(", ");
}

export function Workers({ projectName }: { projectName: string }) {
  const { resources, error } = useProjectResources(projectName);
  const rows = (resources ?? []).filter(
    (r): r is WorkerResource => r.kind === "worker",
  );

  const columns: Column<WorkerResource>[] = [
    { key: "name", header: "Name", cell: (row) => row.name },
    {
      key: "state",
      header: "State",
      cell: (row) => <State state={row.state} />,
    },
    {
      key: "compat",
      header: "Compatibility date",
      cell: (row) => row.config.manifest?.compatibilityDate ?? "Not deployed",
    },
    { key: "bindings", header: "Bindings", cell: bindings },
    {
      key: "active",
      header: "Last active",
      cell: (row) => formatSince(readStats(row).lastActiveAt),
    },
  ];

  return (
    <ResourcePage item={ITEM} error={error} loading={resources === null}>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        empty={
          <EmptyList
            title="No workers in this project"
            hint="hobby deploy, run in a directory holding a wrangler manifest, creates one."
          />
        }
      />
    </ResourcePage>
  );
}
