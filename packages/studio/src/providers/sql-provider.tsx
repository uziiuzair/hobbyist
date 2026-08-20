/**
 * SQL Provider
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
  useState,
} from "react";
import * as api from "../api.js";
import {
  clearHistory,
  deleteSnippet,
  loadHistory,
  loadSnippets,
  pushHistory,
  saveSnippet,
  type HistoryEntry,
  type Snippet,
} from "../lib/sqlStorage.js";
import { useDatabase } from "./database-provider.js";

function randomId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
}

/**
 * The SQL editor's state, and the two local stores behind it.
 *
 * History and snippets live in this browser's localStorage and are never sent
 * anywhere: they are notes about a machine you own, not data the daemon has
 * any business keeping. History is scoped per database, snippets are not,
 * because a snippet is usually the thing you want to run against a second one.
 */
interface SqlContextType {
  sql: string;
  setSql: (next: string) => void;
  result: api.QueryResult | null;
  error: string | null;
  ranMs: number | null;
  running: boolean;
  execute: () => Promise<void>;
  history: HistoryEntry[];
  snippets: Snippet[];
  save: (name: string) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const SqlContext = createContext<SqlContextType>({
  sql: "",
  setSql: () => {},
  result: null,
  error: null,
  ranMs: null,
  running: false,
  execute: () => Promise.reject(new Error("no SqlProvider")),
  history: [],
  snippets: [],
  save: () => {},
  remove: () => {},
  clear: () => {},
});

export const SqlProvider = ({ children }: { children?: React.ReactNode }) => {
  const { resource, run } = useDatabase();

  const [sql, setSql] = useState("");
  const [result, setResult] = useState<api.QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ranMs, setRanMs] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [snippets, setSnippets] = useState<Snippet[]>([]);

  const resourceId = resource?.id ?? null;

  /**
   * Rebinds to the new database's history, and drops the previous result.
   *
   * The editor text survives on purpose: a query you were in the middle of
   * writing is your work, and having it vanish because you glanced at another
   * database is worse than having it point at the wrong one. The result does
   * not survive, because a result set is an answer about a specific database
   * and leaving it under a different name would be a lie.
   */
  useEffect(() => {
    if (resourceId === null) {
      setHistory([]);
      setSnippets([]);
      return;
    }
    setResult(null);
    setError(null);
    setRanMs(null);
    setHistory(loadHistory(window.localStorage, resourceId));
    setSnippets(loadSnippets(window.localStorage));
  }, [resourceId]);

  /**
   * Runs the editor's contents, recording the attempt either way.
   *
   * A failed query is written to history too: the query you need to find
   * again is usually the one that just went wrong. Timing is measured client
   * side because the daemon does not report it, so the figure includes the
   * wake. That is the honest number, since it is what the query cost you
   * rather than what the planner cost.
   */
  const execute = useCallback(async (): Promise<void> => {
    if (resourceId === null || sql.trim().length === 0 || running) return;

    const startedAt = Date.now();
    setRunning(true);
    setError(null);

    try {
      const queryResult = await run(() => api.runQuery(resourceId, sql));
      setResult(queryResult);
      setRanMs(Date.now() - startedAt);
      setHistory(
        pushHistory(window.localStorage, {
          id: randomId(),
          resourceId: resourceId,
          sql: sql,
          ranAt: new Date().toISOString(),
          ok: true,
        }),
      );
    } catch (err) {
      const message = err instanceof api.ApiError ? err.message : "query failed";
      setError(message);
      setResult(null);
      setHistory(
        pushHistory(window.localStorage, {
          id: randomId(),
          resourceId: resourceId,
          sql: sql,
          ranAt: new Date().toISOString(),
          ok: false,
          errorMessage: message,
        }),
      );
    } finally {
      setRunning(false);
    }
  }, [resourceId, sql, running, run]);

  const save = useCallback(
    (name: string): void => {
      if (sql.trim().length === 0 || name.trim().length === 0) return;
      setSnippets(
        saveSnippet(window.localStorage, {
          id: randomId(),
          name: name.trim(),
          sql: sql,
          savedAt: new Date().toISOString(),
        }),
      );
    },
    [sql],
  );

  const remove = useCallback((id: string): void => {
    setSnippets(deleteSnippet(window.localStorage, id));
  }, []);

  /**
   * Clears this database's history only, never every database's.
   */
  const clear = useCallback((): void => {
    if (resourceId === null) return;
    clearHistory(window.localStorage, resourceId);
    setHistory(loadHistory(window.localStorage, resourceId));
  }, [resourceId]);

  return (
    <SqlContext.Provider
      value={{
        sql: sql,
        setSql: setSql,
        result: result,
        error: error,
        ranMs: ranMs,
        running: running,
        execute: execute,
        history: history,
        snippets: snippets,
        save: save,
        remove: remove,
        clear: clear,
      }}
    >
      {children}
    </SqlContext.Provider>
  );
};

export const useSql = () => {
  return useContext(SqlContext);
};
