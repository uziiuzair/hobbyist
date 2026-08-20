import type { ResourceState } from "@hobby.sh/core";

// Sleeping is the only state rendered without colour, on purpose. Every hosted
// dashboard treats a stopped database as a degraded state and dresses it in a
// warning: Supabase pairs "Project is paused" with an info tooltip explaining
// the limitation. Here sleeping is the product working, so it gets a calm
// hollow ring and no chroma at all, and awake gets the only live colour on the
// page. Shape carries the meaning as well as colour, so this survives being
// read by someone who cannot separate the hues.

const LABELS: Record<string, string> = {
  running: "Awake",
  sleeping: "Sleeping",
  starting: "Waking",
  creating: "Creating",
  // Labelled for what it is doing rather than where it is heading: calling a
  // stopping database "sleeping" while showing it a transition animation was
  // the label and the styling telling two different stories.
  stopping: "Stopping",
  failed: "Failed",
  destroying: "Removing",
  // Resting, not transitional: the record exists and no code has been
  // uploaded yet. Rendered without chroma, like sleeping, because a resource
  // waiting for its first deploy is not a problem.
  undeployed: "Not deployed",
};

const CLASSES: Record<string, string> = {
  running: "state-awake",
  sleeping: "state-sleeping",
  starting: "state-waking",
  creating: "state-waking",
  stopping: "state-waking",
  failed: "state-failed",
  destroying: "state-waking",
  undeployed: "state-undeployed",
};

export function stateClass(state: string): string {
  return CLASSES[state] ?? "state-sleeping";
}

export function stateLabel(state: string): string {
  return LABELS[state] ?? state;
}

export function State({
  state,
  label,
  hideLabel,
}: {
  state: ResourceState | string;
  label?: string;
  hideLabel?: boolean;
}) {
  const cls = CLASSES[state] ?? "state-sleeping";
  const text = label ?? LABELS[state] ?? state;
  return (
    <span className={`state ${cls}`}>
      <span className="dot" aria-hidden="true" />
      {!hideLabel && text}
    </span>
  );
}

export function summarise(states: string[]): { state: string; label: string } {
  if (states.length === 0) return { state: "sleeping", label: "No services" };
  if (states.some((s) => s === "failed"))
    return { state: "failed", label: "Failed" };
  if (states.some((s) => s === "starting" || s === "creating"))
    return { state: "starting", label: "Waking" };
  const awake = states.filter((s) => s === "running").length;
  if (awake === 0) {
    // A project whose every service is waiting for its first deploy is not
    // asleep: saying "Sleeping" about code that never arrived would be a lie.
    if (states.every((s) => s === "undeployed"))
      return { state: "undeployed", label: "Not deployed" };
    return { state: "sleeping", label: "Sleeping" };
  }
  if (awake === states.length) return { state: "running", label: "Awake" };
  return { state: "running", label: `${awake} of ${states.length} awake` };
}
