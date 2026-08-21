import { useEffect, useMemo, useState } from "react";
import * as api from "../api.js";
import { useResource } from "../lib/useResource.js";
import { useWakeAwareRun } from "../lib/useWaking.js";
import { WakingBanner } from "../components/WakingBanner.js";
import { Workbench } from "../components/Workbench.js";
import { State } from "../components/State.js";
import { SpotColumns } from "../components/Spot.js";
import {
  loadSchema,
  columnModifiers,
  tableDdl,
  type ColumnInfo,
  type TableInfo,
} from "../lib/schema.js";
import { Button } from "../components/reusable/button.js";

// Read only, deliberately: root CLAUDE.md and docs/studio/CLAUDE.md both
// call out that a correct visual DDL editor has to generate safe
// migrations, and getting that wrong damages real data. Nothing here ever
// issues a write. What it does instead is hand you the DDL, which is the
// half of a schema editor that cannot lose your data.
//
// The shape follows Neon's schema view: the table index on the left, the
// selected table rendered as the statements that would create it. Postgres
// already prints these strings (format_type, pg_get_constraintdef, indexdef),
// so the page shows what the server says rather than a prose translation of
// it. Where Neon colours the DDL like an editor, this stays in the one-chroma
// world the rest of Studio lives in and ranks the parts by ink weight: green
// here would be a third meaning for a hue that already carries action and
// state.

export function Schema({
  projectName,
  resourceName,
  onChanged,
}: {
  projectName: string;
  resourceName: string;
  onChanged?: () => void;
}) {
  const {
    resource,
    error: resourceError,
    refresh,
  } = useResource(projectName, resourceName);
  const { snapshot, run } = useWakeAwareRun(() => {
    refresh();
    onChanged?.();
  });
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (resource === null) return;
    run(resource.id, resource.state, () =>
      loadSchema((sql, params) => api.runQuery(resource.id, sql, params)),
    )
      .then(setTables)
      .catch((err: unknown) =>
        setError(
          err instanceof api.ApiError
            ? err.message
            : "Could not read the schema",
        ),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource?.id]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return tables ?? [];
    return (tables ?? []).filter((t) => t.name.toLowerCase().includes(needle));
  }, [tables, query]);

  const active = tables?.find((t) => t.name === selected) ?? tables?.[0];

  if (resourceError !== null) {
    return (
      <div className="page measure">
        <div className="notice notice-danger">{resourceError}</div>
      </div>
    );
  }

  return (
    <Workbench
      projectName={projectName}
      resourceName={resourceName}
      view="schema"
      sidebar={
        <>
          <div className="wb-side-head">
            <span className="wb-side-title">Schema</span>
            <span className="wb-side-count">{tables?.length ?? 0}</span>
          </div>
          <div className="wb-side-search">
            <div className="search">
              <svg
                width="13"
                height="13"
                viewBox="0 0 13 13"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  cx="5.6"
                  cy="5.6"
                  r="3.9"
                  stroke="currentColor"
                  strokeWidth="1.3"
                />
                <path
                  d="M8.6 8.6 11.3 11.3"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                />
              </svg>
              <input
                className="input"
                placeholder="Search tables"
                aria-label="Search tables"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          <div className="wb-side-list">
            {tables === null && <div className="side-list-empty">Loading</div>}
            {tables?.length === 0 && (
              <div className="side-list-empty">
                No tables in the public schema
              </div>
            )}
            {tables !== null && tables.length > 0 && visible.length === 0 && (
              <div className="side-list-empty">No table matches</div>
            )}
            {visible.map((table) => (
              <Button
                type="button"
                key={table.name}
                className={`wb-table${table.name === active?.name ? " active" : ""}`}
                aria-current={table.name === active?.name ? "page" : undefined}
                onClick={() => setSelected(table.name)}
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 14 14"
                  fill="none"
                  aria-hidden="true"
                >
                  <rect
                    x="1.5"
                    y="2"
                    width="11"
                    height="10"
                    rx="1.5"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                  <path
                    d="M1.5 5.5h11M5.5 5.5V12"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                </svg>
                <span className="wb-table-name">{table.name}</span>
                <span className="wb-table-note">{table.columns.length}</span>
              </Button>
            ))}
          </div>
        </>
      }
    >
      <WakingBanner resourceName={resourceName} snapshot={snapshot} />
      {error !== null && <div className="notice notice-danger">{error}</div>}

      {resource !== null && (
        <div className="schema-bar">
          <span className="schema-name">{active?.name ?? "--"}</span>
          <span className="schema-tag">public</span>
          <State state={resource.state} />
          <div className="schema-bar-right">
            {tables !== null && tables.length > 0 && (
              <CopyButton
                label="Copy schema"
                text={() => tables.map(tableDdl).join("\n\n")}
              />
            )}
            {active !== undefined && (
              <CopyButton label="Copy table" text={() => tableDdl(active)} />
            )}
          </div>
        </div>
      )}

      <div className="schema-body">
        {tables === null ? (
          <span className="dim">Reading the schema</span>
        ) : active === undefined ? (
          <div className="empty">
            <SpotColumns />
            <h3>Nothing to describe yet</h3>
            <p>
              This database has no tables in the public schema. Create one from
              the SQL editor and it appears here.
            </p>
          </div>
        ) : (
          <>
            <Section title="Columns" count={active.columns.length}>
              {active.columns.map((column) => (
                <ColumnLine key={column.name} column={column} table={active} />
              ))}
            </Section>

            {active.constraints.length > 0 && (
              <Section title="Constraints" count={active.constraints.length}>
                {active.constraints.map((constraint) => (
                  <div className="ddl-line" key={constraint.name}>
                    <span className="ddl-kw">CONSTRAINT</span>{" "}
                    <span className="ddl-name">{constraint.name}</span>{" "}
                    <span className="ddl-type">{constraint.definition}</span>
                  </div>
                ))}
              </Section>
            )}

            {active.indexes.length > 0 && (
              <Section title="Indexes" count={active.indexes.length}>
                {active.indexes.map((index) => (
                  <div className="ddl-line" key={index.name}>
                    <span className="ddl-type">{index.definition}</span>
                    {index.unique && <span className="key-tag">unique</span>}
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
      </div>
    </Workbench>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="ddl-section">
      <div className="ddl-head">
        <span className="ddl-title">{title}</span>
        <span className="ddl-count">{count}</span>
      </div>
      <div className="ddl-block">{children}</div>
    </section>
  );
}

// The column exactly as its DDL fragment reads, ranked by ink: the name is
// what you are looking for, the type is what you need next, and the modifiers
// are the detail you only read when they matter. The key chips sit at the end
// rather than inline, because PRIMARY KEY belongs to a constraint and printing
// it on the column too would mean the page and the copied DDL disagree.
function ColumnLine({
  column,
  table,
}: {
  column: ColumnInfo;
  table: TableInfo;
}) {
  const fk = table.foreignKeys.find((f) => f.column === column.name);
  const modifiers = columnModifiers(column);

  return (
    <div className="ddl-line">
      <span className="ddl-name">{column.name}</span>{" "}
      <span className="ddl-type">{column.dataType}</span>
      {modifiers.length > 0 && <span className="ddl-mod"> {modifiers}</span>}
      {column.isPrimaryKey && <span className="key-tag">pk</span>}
      {fk !== undefined && (
        <span className="fk-tag">
          {fk.referencesTable}.{fk.referencesColumn}
        </span>
      )}
    </div>
  );
}

function CopyButton({ label, text }: { label: string; text: () => string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      type="button"
      variant="ghost"
      size="small"
      onClick={() => {
        void navigator.clipboard.writeText(text()).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
