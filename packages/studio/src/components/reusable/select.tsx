/**
 * Select
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 16, 2026
 */

import type { ReactNode } from "react";
import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from "@headlessui/react";
import { cn } from "../../utils/cn";
import { CheckIcon, ChevronDownIcon } from "./icons";

/**
 * A Listbox, not a Menu.
 *
 * The two look alike and mean different things: a menu fires commands and
 * forgets them, a select holds a value and shows which one is held. This is
 * the second, because that is what the only native `<select>` left in Studio
 * does (the database picker that steers the activity chart and the three
 * buttons beside it). An action dropdown is a separate component, and naming
 * it Menu keeps the difference visible at the import.
 *
 * The trigger is deliberately Button's geometry, class for class, since the
 * two sit shoulder to shoulder in a page-actions row and any drift in radius,
 * padding or border shows up as a misaligned edge.
 */
export interface SelectOption<T> {
  value: T;
  label: string;
  /** Second line under the label. Room for the fact that disambiguates two similar options. */
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

interface SelectProps<T> {
  /** null means nothing is chosen yet, which is what renders the placeholder. */
  value: T | null;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  /**
   * Compares two values. Needed only when T is an object, since the default
   * is reference equality and two structurally equal objects from separate
   * fetches would otherwise never match.
   */
  by?: (a: T, b: T) => boolean;
  size?: "regular" | "small";
  disabled?: boolean;
  invalid?: boolean;
  /** Which edge the list hangs from. `end` for a trigger sitting at the right of a row. */
  align?: "start" | "end";
  /** Labels the trigger for screen readers when no visible <label> points at it. */
  label?: string;
  className?: string;
  optionsClassName?: string;
}

export const Select = <T,>(props: SelectProps<T>) => {
  const {
    value,
    onChange,
    options,
    placeholder = "Select",
    by,
    size = "regular",
    disabled = false,
    invalid = false,
    align = "start",
    label,
    className,
    optionsClassName,
  } = props;

  const same = by ?? ((a: T, b: T) => a === b);
  const selected =
    value === null ? undefined : options.find((o) => same(o.value, value));

  return (
    <Listbox
      value={value}
      // Narrowed on the way out: null is an input state (nothing chosen yet),
      // never something the list can hand back, since every option carries a
      // real value. The caller's onChange therefore never has to test for it.
      onChange={(next) => {
        if (next !== null) onChange(next);
      }}
      by={by as never}
      disabled={disabled}
    >
      <ListboxButton
        aria-label={label}
        className={cn(
          // Select Sizing. Mirrors theme.css's own .select and .select-sm:
          // a full width form field, or an auto width control in a toolbar.
          size == "small"
            ? "w-auto py-1 px-2 text-xs gap-1.5"
            : "w-full py-2 px-3 text-sm gap-2",

          // Select Surface
          invalid
            ? "border-danger bg-surface-2 text-ink"
            : "border-line-strong bg-surface-2 text-ink hover:bg-surface-3",

          // Select Open and Focus. The accent line is the same signal every
          // other focused control in theme.css uses, so a focused select does
          // not invent a second one.
          "data-open:border-accent-line focus:border-accent-line focus:outline-none",

          // Select Defaults. `group` is load-bearing: the chevron rotates off
          // the trigger's own data-open, and without it the arrow never turns.
          "group inline-flex items-center justify-between rounded-sm border",
          "font-sans cursor-pointer whitespace-nowrap text-left",
          "data-disabled:opacity-50 data-disabled:cursor-not-allowed",
          "transition-all ease-in",

          // Extended CSS
          className,
        )}
      >
        <span className="inline-flex items-center gap-2 truncate">
          {selected?.icon}
          <span className={cn("truncate", selected === undefined && "text-ink-3")}>
            {selected?.label ?? placeholder}
          </span>
        </span>

        <ChevronDownIcon
          className={cn(
            "shrink-0 text-ink-3 transition-transform ease-in",
            "group-data-open:rotate-180",
            size == "small" ? "size-3.5" : "size-4",
          )}
        />
      </ListboxButton>

      <ListboxOptions
        transition
        anchor={`bottom ${align}`}
        className={cn(
          // Select Menu. The same floating treatment .switcher-menu already
          // uses, so the two popovers in the interface are one thing seen
          // twice: translucent surface over blur, the stronger line, and the
          // pop shadow, which has its own light theme value.
          "z-40 w-(--button-width) min-w-40 max-h-[340px] overflow-y-auto",
          "rounded-card border border-line-strong bg-surface-2/90 p-1",
          "backdrop-blur-[20px] shadow-[var(--shadow-pop)]",
          "[--anchor-gap:6px] focus:outline-none",

          // Select Menu Motion. Scale and fade from the trigger it belongs
          // to, so the list reads as opening out of the control rather than
          // arriving from nowhere.
          "origin-top transition duration-100 ease-out",
          "data-closed:scale-95 data-closed:opacity-0",

          // Extended CSS
          optionsClassName,
        )}
      >
        {options.map((option, index) => (
          <ListboxOption
            key={index}
            value={option.value}
            disabled={option.disabled}
            className={cn(
              "group flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5",
              "cursor-pointer text-sm text-ink-2 select-none",
              // Focus is keyboard and pointer both, which is why the hover
              // tint is bound to data-focus rather than :hover: arrowing down
              // the list has to look like moving through it.
              "data-focus:bg-surface-3 data-focus:text-ink",
              "data-selected:text-ink",
              "data-disabled:opacity-50 data-disabled:cursor-not-allowed",
            )}
          >
            {option.icon}

            <span className="flex min-w-0 flex-col">
              <span className="truncate">{option.label}</span>
              {option.description !== undefined && (
                <span className="truncate text-xs text-ink-3">
                  {option.description}
                </span>
              )}
            </span>

            {/* Held rather than conditionally rendered: a tick that appears
                and disappears reflows every label beside it as the selection
                moves down the list. */}
            <CheckIcon
              aria-hidden="true"
              className="ml-auto size-4 shrink-0 text-accent opacity-0 group-data-selected:opacity-100"
            />
          </ListboxOption>
        ))}
      </ListboxOptions>
    </Listbox>
  );
};
