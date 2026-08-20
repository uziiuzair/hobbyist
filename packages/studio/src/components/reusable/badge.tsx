/**
 * Badge
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import { cn } from "../../utils/cn";

interface BadgeProps {
  /**
   * `soon` is the load-bearing one: it marks a destination that exists in the
   * rail and not on the disk. Its border is dashed on purpose, because a
   * dashed edge reads as provisional at a glance and does not need the row to
   * be read to be understood.
   */
  tone?: "soon" | "preview" | "neutral" | "accent";
  className?: string;
  children?: React.ReactNode;
}

export const Badge = (props: BadgeProps) => {
  const { tone = "neutral", className, children } = props;

  return (
    <span
      className={cn(
        // Badge Tone
        tone == "soon"
          ? "border-dashed border-line-strong text-ink-3"
          : tone == "preview"
            ? "border-dashed border-line-strong text-honey"
            : tone == "accent"
              ? "border-accent-line text-accent"
              : "border-line bg-surface-2 text-ink-3",

        // Badge Defaults
        "inline-flex flex-none items-center rounded-full border",
        "px-1.5 py-px text-[10.5px] leading-[1.6] font-sans whitespace-nowrap",

        // Extended CSS
        className,
      )}
    >
      {children}
    </span>
  );
};
