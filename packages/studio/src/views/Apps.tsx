/**
 * Apps List
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
import type { AppResource } from "@hobby.sh/core";

const ITEM = findProjectItem("apps")!;

export function Apps({ projectName }: { projectName: string }) {
  const { resources, error } = useProjectResources(projectName);
  const rows = (resources ?? []).filter(
    (r): r is AppResource => r.kind === "app",
  );

  const columns: Column<AppResource>[] = [
    { key: "name", header: "Name", cell: (row) => row.name },
    {
      key: "state",
      header: "State",
      cell: (row) => <State state={row.state} />,
    },
    {
      key: "source",
      // An app is either built from a directory on this box or pulled as an
      // image, and which one it is decides what a redeploy even means.
      header: "Source",
      cell: (row) =>
        row.config.source !== null ? (
          <span className="mono text-xs">{row.config.source.path}</span>
        ) : row.config.image !== null ? (
          <span className="mono text-xs">{row.config.image}</span>
        ) : (
          "Not deployed"
        ),
    },
    {
      key: "port",
      header: "Port",
      className: "tabular-nums",
      cell: (row) => row.config.containerPort,
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
        empty={
          <EmptyList
            title="No apps in this project"
            hint="hobby deploy, run in a directory holding a Dockerfile, creates one."
          />
        }
      />
    </ResourcePage>
  );
}
