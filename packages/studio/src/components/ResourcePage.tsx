/**
 * Resource Page
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import type { ReactNode } from "react";
import type { NavItem } from "../nav.js";
import { statusLabel } from "../nav.js";
import { Page } from "./reusable/page.js";
import { Badge } from "./reusable/badge.js";

/**
 * The frame every resource list shares: the nav entry's own title and
 * sentence, its status badge, and the three states a list can be in before it
 * is a list (failed, loading, ready).
 *
 * Taking the title and description from the nav entry rather than a prop is
 * the point. The rail and the page it opens cannot describe the same feature
 * differently, because there is only one description.
 */
export function ResourcePage({
  item,
  error,
  loading,
  actions,
  children,
}: {
  item: NavItem;
  error: string | null;
  loading: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
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
      actions={actions}
      banner={
        // The gap is stated on the page that has it, not only in a tooltip.
        // A list that shows four columns where the managed dashboard shows
        // nine looks finished unless it says otherwise.
        item.status === "preview" ? (
          <div className="border-line bg-surface-2 text-ink-2 rounded-card border px-4 py-3 text-sm leading-relaxed">
            {item.today}
          </div>
        ) : undefined
      }
    >
      {error !== null ? (
        <div className="notice notice-danger">{error}</div>
      ) : loading ? (
        <span className="text-ink-3 text-sm">Loading</span>
      ) : (
        children
      )}
    </Page>
  );
}

/** What a list says when the project genuinely holds none of this kind. */
export function EmptyList({ title, hint }: { title: string; hint: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <p className="text-ink text-sm">{title}</p>
      <p className="text-ink-3 max-w-md text-sm">{hint}</p>
    </div>
  );
}
