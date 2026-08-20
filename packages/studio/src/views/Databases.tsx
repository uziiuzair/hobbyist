/**
 * Databases List
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import { formatBytes, formatSince, readStats } from "../lib/format.js";
import { useProjectResources } from "../lib/useProjectResources.js";
import { findProjectItem } from "../nav.js";
import { State } from "../components/State.js";
import { ResourcePage, EmptyList } from "../components/ResourcePage.js";
import { Table } from "../components/reusable/table.js";
import type { Column } from "../components/reusable/table.js";
import type { PostgresResource } from "@hobby.sh/core";

const ITEM = findProjectItem("databases")!;

export function Databases({ projectName }: { projectName: string }) {
  const { resources, error } = useProjectResources(projectName);
  const rows = (resources ?? []).filter(
    (r): r is PostgresResource => r.kind === "postgres",
  );

  const base = `#/projects/${encodeURIComponent(projectName)}/resources`;

  const columns: Column<PostgresResource>[] = [
    {
      key: "name",
      header: "Name",
      cell: (row) => row.name,
    },
    {
      key: "state",
      header: "State",
      cell: (row) => <State state={row.state} />,
    },
    {
      key: "size",
      header: "Size",
      className: "tabular-nums",
      cell: (row) => formatBytes(readStats(row).sizeBytes),
    },
    {
      key: "connections",
      header: "Connections",
      className: "tabular-nums",
      // A sleeping database has no server to count against, which is a
      // different fact from zero clients being attached to a running one.
      cell: (row) =>
        row.state === "running" ? (readStats(row).connectionCount ?? 0) : "--",
    },
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
        rowHref={(row) => `${base}/${encodeURIComponent(row.name)}/tables`}
        empty={
          <EmptyList
            title="No databases in this project"
            hint="Create one from the project overview, or run hobby create."
          />
        }
      />
    </ResourcePage>
  );
}
