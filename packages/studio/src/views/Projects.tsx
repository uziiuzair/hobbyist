/**
 * Projects Page
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Oct 30, 2026
 */

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import * as api from "../api.js";
import { navigate } from "../lib/router.js";
import { formatSince, readStats } from "../lib/format.js";
import { describeError } from "../lib/errors.js";
import {
  createProjectWithDefaults,
  DEFAULT_POSTGRES_NAME,
} from "../lib/createProject.js";
import { State, summarise } from "../components/State.js";
import { MachineStrip } from "../components/MachineStrip.js";
import { Modal } from "../components/Modal.js";
import type { RailProject } from "../components/Shell.js";
import { Wrapper } from "../components/reusable/wrapper.js";
import { Search } from "../components/reusable/search.js";
import {
  AlertTriangleIcon,
  CodeSquareIcon,
} from "../components/reusable/icons.js";
import { Button } from "../components/reusable/button.js";

interface Props {
  rows: RailProject[];
  freeBytes: number | null;
  onChanged: () => void;
}

type Filter = "all" | "awake" | "sleeping";

// The home page shows what the API returns and nothing it does not: the
// project list, the machine strip (awake count, databases, free disk, all
// read from the daemon), and a way to add a project. A "Recommended" block
// of hardcoded security findings used to sit below the list (issue #121);
// it read as a real alert about a real domain, and nothing backed it, so it
// is gone rather than replaced with something else invented.
export function Projects({ rows, freeBytes, onChanged }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (needle.length > 0 && !row.project.name.toLowerCase().includes(needle))
        return false;
      const awake = row.resources.some((r) => r.state === "running");
      if (filter === "awake") return awake;
      if (filter === "sleeping") return !awake;
      return true;
    });
  }, [rows, query, filter]);

  const totals = useMemo(() => {
    const resources = rows.flatMap((row) => row.resources);
    return {
      databases: resources.length,
      awake: resources.filter((r) => r.state === "running").length,
      bytes: resources.reduce(
        (sum, r) => sum + (readStats(r).sizeBytes ?? 0),
        0,
      ),
    };
  }, [rows]);

  return (
    <Wrapper>
      <div className="flex flex-col gap-6 py-12">
        <section className="text-center">
          <h1>What's on the agenda?</h1>
        </section>

        <section>
          <MachineStrip
            awake={totals.awake}
            total={totals.databases}
            freeBytes={freeBytes}
          />

          {/* The create control lives beside the search, always, so a second
              project is one click away whether the list has one project in
              it or fifty (issue #122: it used to exist only in the empty
              state, and the no-match state's copy of it did nothing). */}
          <div className="flex items-center gap-3">
            <Search
              placeholder="Search projects"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search projects"
            />
            <Button
              type="button"
              variant="primary"
              className="shrink-0"
              onClick={() => setCreating(true)}
            >
              New project
            </Button>
          </div>
        </section>

        <section className="grid grid-cols-3 gap-x-4 gap-y-0">
          {rows.length === 0 ? (
            <div className="flex items-center flex-col col-span-3 gap-3">
              <p>You currently do not have any projects</p>
              <Button type="button" onClick={() => setCreating(true)}>
                Create a Project
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex items-center flex-col col-span-3 gap-3">
              <p>
                No projects match
                {query.trim().length > 0 ? ` "${query.trim()}"` : ""}
              </p>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear search
              </Button>
            </div>
          ) : (
            <>
              {visible.map((row) => {
                const stats = row.resources.map((r) => readStats(r));
                const summary = summarise(row.resources.map((r) => r.state));
                const lastActive = stats
                  .map((s) => s.lastActiveAt ?? null)
                  .filter((v): v is string => v !== null)
                  .sort()
                  .pop();

                return (
                  <div
                    key={row.project.id}
                    className="border-b border-line py-0.5"
                  >
                    <a
                      href={`#/projects/${encodeURIComponent(row.project.name)}`}
                      className="flex items-center justify-between text-ink py-3.5 px-4 transition-all duration-300 hover:bg-surface-2 rounded-md"
                    >
                      <div className="flex items-center gap-2.5">
                        <CodeSquareIcon className="size-4 text-rose" />
                        <div>
                          <p>{row.project.name}</p>
                          <p className="text-xs text-ink-3">
                            {formatSince(lastActive)}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {summary.state == "failed" ? (
                          <AlertTriangleIcon className="size-4 text-danger" />
                        ) : (
                          <State
                            state={summary.state}
                            label={summary.label}
                            hideLabel
                          />
                        )}
                      </div>
                    </a>
                  </div>
                );
              })}
            </>
          )}
        </section>
      </div>

      {creating && (
        <NewProjectModal
          onClose={() => setCreating(false)}
          onCreated={(name) => {
            setCreating(false);
            onChanged();
            navigate(`/projects/${encodeURIComponent(name)}`);
          }}
        />
      )}
    </Wrapper>
  );
}

// The same two shapes `hobby new` offers (packages/cli/src/cli/commands.ts,
// cmdNew): a project with a postgres named primary in it, or, with the box
// ticked, a project and nothing else (`hobby new --empty`). The sequence and
// the rollback live in lib/createProject.ts so they can be tested without a
// DOM and stay the CLI's sequence.
function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    createProjectWithDefaults(api, trimmed, { empty })
      .then(() => onCreated(trimmed))
      .catch((err: unknown) => {
        setError(
          err instanceof Error
            ? describeError(err, err.message)
            : String(err),
        );
        setBusy(false);
      });
  }

  return (
    <Modal
      title="New project"
      description={
        empty
          ? "A project holds your databases. This one starts with nothing in it; add a database or deploy into it afterwards."
          : `A project holds your databases. This one starts with a Postgres named ${DEFAULT_POSTGRES_NAME}.`
      }
      onClose={busy ? () => undefined : onClose}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-project-form"
            variant="primary"
            disabled={busy || name.trim().length === 0}
          >
            {busy && <span className="spinner" />}
            {busy ? "Creating" : "Create project"}
          </Button>
        </>
      }
    >
      <form id="new-project-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-project-name">Name</label>
          <input
            id="new-project-name"
            className="input mono"
            value={name}
            placeholder="blog"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
          <p
            className="dim"
            style={{ margin: 0, fontSize: 12.5, lineHeight: 1.45 }}
          >
            Lowercase letters, numbers and dashes. This becomes the database
            name in your connection string.
          </p>
        </div>
        <div className="field">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={empty}
              disabled={busy}
              onChange={(e) => setEmpty(e.target.checked)}
            />
            Start empty, with no database
          </label>
        </div>
        {error !== null && (
          <div className="notice notice-danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
