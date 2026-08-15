import clsx from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (
  ...classes: (string | undefined | null | false)[]
): string => {
  return clsx(twMerge(...classes));
};
