/**
 * Coming Soon Page
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import type { NavItem } from "../nav.js";
import { statusLabel } from "../nav.js";
import { Page } from "../components/reusable/page.js";
import { Badge } from "../components/reusable/badge.js";

/**
 * The page behind every unfinished destination in the rail.
 *
 * It is deliberately not an empty state. An empty state says "there is
 * nothing here yet" and lets you assume that creating one would fill it; this
 * says the feature does not exist, names what does work in its place, and
 * stops. The repo rule it serves is the strongest one in CLAUDE.md: a reader
 * must never execute an aspiration.
 *
 * There is no waitlist, no notify me, and no roadmap date, because there is
 * no business behind this to promise one.
 */
export function Soon({ item }: { item: NavItem }) {
  const label = statusLabel(item.status);

  return (
    <Page
      title={
        <span className="flex items-center gap-2.5">
          {item.label}
          {label !== null && (
            <Badge tone={item.status === "preview" ? "preview" : "soon"}>
              {label}
            </Badge>
          )}
        </span>
      }
      description={item.blurb}
    >
      <div className="border-line bg-surface rounded-card border p-5">
        <p className="text-ink text-sm font-medium">
          {item.status === "preview"
            ? "Partly built. This is what is missing."
            : "Not built. Nothing on this page reads or writes anything."}
        </p>
        <p className="text-ink-2 mt-2 text-sm leading-relaxed">{item.today}</p>
      </div>

      <dl className="border-line bg-surface rounded-card grid grid-cols-2 gap-px border text-sm">
        <div className="flex flex-col gap-1 p-4">
          <dt className="text-ink-3 text-xs">Roadmap</dt>
          <dd className="text-ink">{item.phase}</dd>
        </div>
        <div className="border-line flex flex-col gap-1 border-l p-4">
          <dt className="text-ink-3 text-xs">Status</dt>
          <dd className="text-ink">
            {item.status === "preview" ? "Preview" : "Not started"}
          </dd>
        </div>
      </dl>

      <p className="text-ink-3 text-xs leading-relaxed">
        This destination is in the rail because the rail is the roadmap, not a
        list of finished pages. It is marked because a map you cannot trust is
        worse than no map.
      </p>
    </Page>
  );
}
