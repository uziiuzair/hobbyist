/**
 * Button
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import { cn } from "../../utils/cn";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "danger" | "ghost";
  size?: "regular" | "small";
}

export const Button = (props: ButtonProps) => {
  const {
    variant = "primary",
    size = "regular",
    className,
    children,
    ...rest
  } = props;

  return (
    <button
      {...rest}
      className={cn(
        // Button Primary
        variant == "primary"
          ? "bg-accent text-accent-ink border-accent hover:bg-accent-hover disabled:bg-accent disabled:border-accent"
          : // Button Danger
            variant == "danger"
            ? "bg-red-900 text-danger border-red-900 hover:bg-danger-dim"
            : // Button Ghost
              variant == "ghost"
              ? "bg-transparent border-transparent text-ink-2 hover:bg-surface-2 hover:text-ink"
              : // Button Default
                "border-line-strong bg-surface-2 text-ink hover:bg-surface-3",

        // Button Size
        size == "small" ? "py-1 px-2 text-xs" : "py-2 px-4 text-sm",

        // Button Defaults
        "inline-flex items-center gap-2 rounded-sm border",
        "font-sans cursor-pointer whitespace-nowrap",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "transition-all ease-in",

        // Extended CSS
        className,
      )}
    >
      {children}
    </button>
  );
};
