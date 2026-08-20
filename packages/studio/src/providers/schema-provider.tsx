/**
 * Schema Provider
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import * as api from "../api.js";
import { loadSchema, type TableInfo } from "../lib/schema.js";
import { useDatabase } from "./database-provider.js";

/**
 * The public schema of the current database, read once per database.
 *
 * Read only, deliberately. A correct visual DDL editor has to generate safe
 * migrations, and getting that wrong damages real data, so nothing here ever
 * issues a write. Tables, Sql and Schema all want this same list, which is
 * why it is loaded once here instead of three times on three routes.
 */
interface SchemaContextType {
  tables: TableInfo[] | null;
  error: string | null;
  query: string;
  setQuery: (next: string) => void;
  visible: TableInfo[];
  selected: string | null;
  select: (name: string | null) => void;
  active: TableInfo | undefined;
  refresh: () => void;
}

const SchemaContext = createContext<SchemaContextType>({
  tables: null,
  error: null,
  query: "",
  setQuery: () => {},
  visible: [],
  selected: null,
  select: () => {},
  active: undefined,
  refresh: () => {},
});

export const SchemaProvider = ({ children }: { children?: React.ReactNode }) => {
  const { resource, run } = useDatabase();

  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const resourceId = resource?.id ?? null;

  /**
   * Loads the whole schema inside one waking run.
   *
   * One run, not one per statement: loadSchema issues several queries, and
   * wrapping each of them separately would count several wakes for what is,
   * to the person watching, a single "open this database" action.
   */
  const refresh = useCallback(() => {
    if (resourceId === null) return;
    setError(null);
    run(() =>
      loadSchema((sql, params) => api.runQuery(resourceId, sql, params)),
    )
      .then(setTables)
      .catch((err: unknown) =>
        setError(
          err instanceof api.ApiError
            ? err.message
            : "Could not read the schema",
        ),
      );
  }, [resourceId, run]);

  /**
   * Reloads on a database change, clearing first.
   *
   * Table names are the one thing on screen that look identical between two
   * databases, so showing the previous one's list while the new one loads is
   * the failure that is hardest to notice.
   */
  useEffect(() => {
    setTables(null);
    setSelected(null);
    setQuery("");
    refresh();
  }, [resourceId, refresh]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return tables ?? [];
    return (tables ?? []).filter((t) => t.name.toLowerCase().includes(needle));
  }, [tables, query]);

  // Falls back to the first table so a freshly opened database shows
  // something rather than an empty pane with a full sidebar beside it.
  const active = useMemo(
    () => tables?.find((t) => t.name === selected) ?? tables?.[0],
    [tables, selected],
  );

  return (
    <SchemaContext.Provider
      value={{
        tables: tables,
        error: error,
        query: query,
        setQuery: setQuery,
        visible: visible,
        selected: selected,
        select: setSelected,
        active: active,
        refresh: refresh,
      }}
    >
      {children}
    </SchemaContext.Provider>
  );
};

export const useSchema = () => {
  return useContext(SchemaContext);
};
