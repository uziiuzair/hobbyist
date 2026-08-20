/**
 * Durable Objects List
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import { useProjectResources } from "../lib/useProjectResources.js";
import { findProjectItem } from "../nav.js";
import { State } from "../components/State.js";
import { ResourcePage, EmptyList } from "../components/ResourcePage.js";
import { Table } from "../components/reusable/table.js";
import type { Column } from "../components/reusable/table.js";
import type { WorkerResource } from "@hobby.sh/core";

const ITEM = findProjectItem("durable-objects")!;

interface NamespaceRow {
  worker: WorkerResource;
  binding: string;
  className: string;
}

export function DurableObjects({ projectName }: { projectName: string }) {
  const { resources, error } = useProjectResources(projectName);

  // Declared, not discovered. These come from each worker's deployed manifest,
  // which is the only place the daemon publishes them; the objects themselves
  // are sqlite files under the worker's data directory and no route reads
  // them, so this page cannot say how many instances exist, how large they
  // are, or when their next alarm fires. Showing an instance count of zero
  // would be the wrong lie: zero means none exist, and the truth is that
  // nobody asked.
  const rows: NamespaceRow[] = (resources ?? [])
    .filter((r): r is WorkerResource => r.kind === "worker")
    .flatMap((worker) =>
      (worker.config.manifest?.durableObjects ?? []).map((declared) => ({
        worker: worker,
        binding: declared.binding,
        className: declared.className,
      })),
    );

  const columns: Column<NamespaceRow>[] = [
    { key: "class", header: "Namespace", cell: (row) => row.className },
    {
      key: "binding",
      header: "Binding",
      cell: (row) => <span className="mono text-xs">{row.binding}</span>,
    },
    { key: "worker", header: "Worker", cell: (row) => row.worker.name },
    {
      key: "state",
      // An object cannot be running while the worker holding it is asleep, so
      // the worker's state is the honest state of the namespace.
      header: "Worker state",
      cell: (row) => <State state={row.worker.state} />,
    },
    {
      key: "storage",
      header: "Storage",
      cell: () => <span className="text-ink-3">Not readable yet</span>,
    },
  ];

  return (
    <ResourcePage item={ITEM} error={error} loading={resources === null}>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.worker.id}:${row.className}`}
        empty={
          <EmptyList
            title="No Durable Object namespaces declared"
            hint="A worker declares these in its wrangler manifest, and they appear here after its next deploy."
          />
        }
      />
    </ResourcePage>
  );
}
