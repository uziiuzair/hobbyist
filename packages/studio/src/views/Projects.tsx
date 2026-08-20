/**
 * Projects Page
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import { useMemo, useState } from "react";
import type { FormEvent } from "react";
import * as api from "../api.js";
import { navigate } from "../lib/router.js";
import { formatSince, readStats } from "../lib/format.js";
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
import { Alert } from "../components/reusable/alert.js";
import { Pill } from "../components/reusable/pill.js";
import { Button } from "../components/reusable/button.js";

interface Props {
  rows: RailProject[];
  freeBytes: number | null;
  onChanged: () => void;
}

type Filter = "all" | "awake" | "sleeping";

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

          <Search
            placeholder="Search projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search projects"
          />
        </section>

        <section className="grid grid-cols-3 gap-x-4 gap-y-0">
          {rows.length === 0 ? (
            <div className="flex items-center flex-col col-span-3 gap-3">
              <p>You currently do not have any projects</p>
              <Button onClick={() => setCreating(true)}>
                Create a Project
              </Button>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex items-center flex-col col-span-3 gap-3">
              <p>You currently do not have any projects</p>
              <Button>Create a Project</Button>
            </div>
          ) : (
            <>
              {visible.map((row, i) => {
                const stats = row.resources.map((r) => readStats(r));
                const summary = summarise(row.resources.map((r) => r.state));
                const bytes = stats.reduce(
                  (sum, s) => sum + (s.sizeBytes ?? 0),
                  0,
                );
                const lastActive = stats
                  .map((s) => s.lastActiveAt ?? null)
                  .filter((v): v is string => v !== null)
                  .sort()
                  .pop();

                return (
                  <div className="border-b border-line py-0.5">
                    <a
                      key={row.project.id}
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

        <section>
          <div className="flex items-center gap-4">
            <h2>Recommended</h2>

            <Pill>3</Pill>
          </div>

          <div className="flex flex-col gap-2">
            <Alert className="z-10" />
            <Alert className="-translate-y-full z-9 scale-99" />
            <Alert className="translate-y-[-200%] z-8 scale-98" />
          </div>
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

function NewProjectModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    api
      .createProject(trimmed)
      .then(() => api.createResource(trimmed, "primary"))
      .then(() => onCreated(trimmed))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  }

  return (
    <Modal
      title="New project"
      description="A project holds your databases. This one starts with a Postgres named primary."
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
        {error !== null && (
          <div className="notice notice-danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
