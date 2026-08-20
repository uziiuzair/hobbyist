import { useEffect, useState } from "react";
import type { Resource } from "@hobby.sh/core";
import * as api from "../api.js";
import { Modal } from "./Modal.js";
import { Button } from "./reusable/button.js";

// Connect, export and import all need the same one secret and all answer the
// same question: what do I type. They share a file because they share that
// shape, and because the connection string is fetched in exactly one place.
//
// Export and import are commands rather than buttons on purpose. The daemon
// has no dump route and no upload route, and CLAUDE.md is explicit that a
// reader must never execute an aspiration, so this hands you the real command
// against the real credential instead of a control that does not exist. It is
// also the more useful answer: the data directory is a plain PGDATA and
// pg_dump has always worked against it.

function CopyRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="field">
      <label>{label}</label>
      <div className="connstring">
        <code>{value}</code>
        <Button type="button" variant="ghost" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {hint !== undefined && <p className="field-hint">{hint}</p>}
    </div>
  );
}

// One fetch, one place. The connection string carries the real password (it is
// the one route that deliberately returns it, see packages/cli/src/daemon/wire.ts),
// so it is requested when a modal opens and never held on the page behind it.
function useConnectionString(resourceId: string): {
  value: string | null;
  error: string | null;
} {
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .connectionString(resourceId)
      .then((result) => {
        if (live) setValue(result.connectionString);
      })
      .catch((err: unknown) => {
        if (live)
          setError(
            err instanceof api.ApiError
              ? err.message
              : "Could not read the connection string",
          );
      });
    return () => {
      live = false;
    };
  }, [resourceId]);

  return { value, error };
}

function Body({
  value,
  error,
  children,
}: {
  value: string | null;
  error: string | null;
  children: (conn: string) => React.ReactNode;
}) {
  if (error !== null)
    return <div className="notice notice-danger">{error}</div>;
  if (value === null) return <span className="dim">Loading</span>;
  return <>{children(value)}</>;
}

function CloseFooter({ onClose }: { onClose: () => void }) {
  return (
    <Button type="button" onClick={onClose}>
      Close
    </Button>
  );
}

export function ConnectModal({
  resource,
  onClose,
}: {
  resource: Resource;
  onClose: () => void;
}) {
  const { value, error } = useConnectionString(resource.id);

  return (
    <Modal
      title={`Connect to ${resource.name}`}
      description="Anything that opens this connection wakes the database first. You do not have to start it yourself."
      onClose={onClose}
      footer={<CloseFooter onClose={onClose} />}
    >
      <Body value={value} error={error}>
        {(conn) => (
          <>
            <CopyRow label="Connection string" value={conn} />
            <CopyRow
              label="psql"
              value={`psql "${conn}"`}
              hint="Waking takes about a second from cold, so the first connection is a little slower than the rest."
            />
            <CopyRow
              label="Environment variable"
              value={`DATABASE_URL="${conn}"`}
            />
          </>
        )}
      </Body>
    </Modal>
  );
}

export function ExportModal({
  resource,
  projectName,
  onClose,
}: {
  resource: Resource;
  projectName: string;
  onClose: () => void;
}) {
  const { value, error } = useConnectionString(resource.id);

  return (
    <Modal
      title={`Export ${resource.name}`}
      description="Run these on the box. Studio holds no database connection of its own, so it hands you the command rather than the file."
      onClose={onClose}
      footer={<CloseFooter onClose={onClose} />}
    >
      <Body value={value} error={error}>
        {(conn) => (
          <>
            <CopyRow
              label="Dump the database"
              value={`pg_dump "${conn}" > ${resource.name}.sql`}
              hint="Plain SQL, restorable anywhere. The database wakes to answer and goes back to sleep on its own afterwards."
            />
            <CopyRow
              label="Dump in the custom format"
              value={`pg_dump -Fc "${conn}" > ${resource.name}.dump`}
              hint="Smaller, and pg_restore can pick single tables out of it."
            />
            <CopyRow
              label="Take the whole project instead"
              value={`hobby eject ${projectName}`}
              hint="Hands you a docker-compose.yml and the data directory, and gets out of the way. Nothing here is a format only Hobbyist can read."
            />
          </>
        )}
      </Body>
    </Modal>
  );
}

export function ImportModal({
  resource,
  onClose,
}: {
  resource: Resource;
  onClose: () => void;
}) {
  const { value, error } = useConnectionString(resource.id);

  return (
    <Modal
      title={`Import into ${resource.name}`}
      description="Run these on the box. There is no upload path: your dump never travels through the browser."
      onClose={onClose}
      footer={<CloseFooter onClose={onClose} />}
    >
      <Body value={value} error={error}>
        {(conn) => (
          <>
            <CopyRow
              label="Restore a plain SQL dump"
              value={`psql "${conn}" < dump.sql`}
              hint="Connecting wakes the database, so there is nothing to start first."
            />
            <CopyRow
              label="Restore a custom format dump"
              value={`pg_restore -d "${conn}" dump.dump`}
            />
            <CopyRow
              label="Copy from another Postgres"
              value={`pg_dump "$SOURCE_URL" | psql "${conn}"`}
              hint="Straight from a hosted database into this one, without a file in between."
            />
          </>
        )}
      </Body>
    </Modal>
  );
}
