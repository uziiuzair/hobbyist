/**
 * Page
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import type { ReactNode } from "react";
import { Wrapper } from "./wrapper";

interface PageProps {
  title: ReactNode;
  /** The sentence under the title. What this page is for, not how to use it. */
  description?: ReactNode;
  /** Buttons in the top right, in the order they are least to most final. */
  actions?: ReactNode;
  /** Sits under the head, above the content: for a status the whole page shares. */
  banner?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
}

/**
 * The head every list page shares. It exists because the resource pages are
 * the same page five times over with a different noun in it, and the moment
 * that head is copied five times the fifth one drifts.
 */
export const Page = (props: PageProps) => {
  const { title, description, actions, banner, wide, children } = props;

  return (
    <Wrapper wide={wide}>
      <div className="flex flex-col gap-6 py-10">
        <header className="flex items-start justify-between gap-6">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-ink text-2xl font-semibold tracking-tight">
              {title}
            </h1>
            {description !== undefined && (
              <p className="text-ink-3 max-w-2xl text-sm">{description}</p>
            )}
          </div>
          {actions !== undefined && (
            <div className="flex flex-none items-center gap-2">{actions}</div>
          )}
        </header>

        {banner}
        {children}
      </div>
    </Wrapper>
  );
};
