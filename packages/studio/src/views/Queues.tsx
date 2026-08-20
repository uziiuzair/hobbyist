/**
 * Queues List
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import { useCallback, useEffect, useState } from "react";
import * as api from "../api.js";
import { findProjectItem } from "../nav.js";
import { State } from "../components/State.js";
import { ResourcePage, EmptyList } from "../components/ResourcePage.js";
import { Table } from "../components/reusable/table.js";
import type { Column } from "../components/reusable/table.js";

const ITEM = findProjectItem("queues")!;

// Coarse on purpose, like formatSince: an operator acts on "this backlog is
// hours old", never on the seconds.
function formatAge(seconds: number | null): string {
  if (seconds === null) return "--";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function Queues({ projectName }: { projectName: string }) {
  const [queues, setQueues] = useState<api.QueueEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .listQueues(projectName)
      .then((result) => {
        setQueues(result.queues);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [projectName]);

  useEffect(() => {
    setQueues(null);
    setError(null);
    refresh();
  }, [projectName, refresh]);

  const columns: Column<api.QueueEntry>[] = [
    { key: "name", header: "Name", cell: (row) => row.resource.name },
    {
      key: "state",
      header: "State",
      cell: (row) => <State state={row.resource.state} />,
    },
    {
      key: "depth",
      header: "Depth",
      className: "tabular-nums",
      cell: (row) => row.depth,
    },
    {
      key: "oldest",
      // The number that decides whether a backlog is a queue doing its job or
      // a consumer that never woke.
      header: "Oldest message",
      className: "tabular-nums",
      cell: (row) => formatAge(row.oldestMessageAgeSeconds),
    },
    {
      key: "consumer",
      header: "Consumer",
      cell: (row) =>
        row.consumer === null ? (
          <span className="text-ink-3">None</span>
        ) : (
          row.consumer.name
        ),
    },
  ];

  return (
    <ResourcePage item={ITEM} error={error} loading={queues === null}>
      <Table
        columns={columns}
        rows={queues ?? []}
        rowKey={(row) => row.resource.id}
        empty={
          <EmptyList
            title="No queues in this project"
            hint="hobby queue create makes one, and a worker that names it as a consumer binds to it on its next deploy."
          />
        }
      />
    </ResourcePage>
  );
}
