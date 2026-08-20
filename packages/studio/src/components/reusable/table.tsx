/**
 * Table
 *
 * @author Uzair Hayat <business@uziiuzair.com>
 *
 * Last updated: Aug 20, 2026
 */

import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** Alignment and width live here, on the column, so header and cell cannot disagree. */
  className?: string;
  cell: (row: T) => ReactNode;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** Makes the whole row a destination. The first cell carries the link text. */
  rowHref?: (row: T) => string;
  /** Shown in place of the body when there are no rows. */
  empty?: ReactNode;
  className?: string;
}

/**
 * A real <table>, not a grid of divs. Screen readers announce column headers
 * with the cell, which is the entire reason these pages are tables rather
 * than lists: "Ready, state" is useful, "Ready" alone is not.
 *
 * A linked row wraps its first cell rather than the row itself, because an
 * <a> cannot contain <td> siblings and a row level onClick is not reachable
 * by keyboard without rebuilding what a link already does.
 */
export const Table = <T,>(props: TableProps<T>) => {
  const { columns, rows, rowKey, rowHref, empty, className } = props;

  if (rows.length === 0 && empty !== undefined) {
    return (
      <div className="border-line bg-surface rounded-card border px-4 py-10 text-center">
        {empty}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "border-line bg-surface rounded-card overflow-x-auto border",
        className,
      )}
    >
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-line border-b">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cn(
                  "text-ink-3 px-4 py-2.5 text-left font-medium whitespace-nowrap",
                  column.className,
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-line hover:bg-surface-2 border-b transition-colors last:border-b-0"
            >
              {columns.map((column, index) => (
                <td
                  key={column.key}
                  className={cn(
                    "text-ink-2 px-4 py-3 align-middle",
                    column.className,
                  )}
                >
                  {index === 0 && rowHref !== undefined ? (
                    <a
                      className="text-ink hover:text-accent transition-colors"
                      href={rowHref(row)}
                    >
                      {column.cell(row)}
                    </a>
                  ) : (
                    column.cell(row)
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
