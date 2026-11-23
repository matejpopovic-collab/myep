/* ============================================================================
   EPROSTA — column-sortable table
   ----------------------------------------------------------------------------
   Written once because most of the report screens need exactly the same
   behaviour, including the `aria-sort` state the critique flagged as missing
   and keyboard-operable headers.

   `useSort` holds the state; `sortRows` does the comparison and keeps nulls
   last regardless of direction, so a column of mostly-empty dates does not
   bury the rows that matter when you flip it.
   ========================================================================== */

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { EmptyState } from './primitives';
import * as PREFS from '@/lib/prefs';
import { usePrefsVersion } from '@/lib/useStore';

export interface Column<R> {
  key: string;
  label: string;
  /** Present => the header is sortable on this key. */
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  nowrap?: boolean;
  cell: (row: R) => ReactNode;
}

export interface SortState {
  key: string;
  dir: 1 | -1;
}

export function useSort(initial: SortState) {
  const [sort, setSort] = useState<SortState>(initial);
  const toggle = (key: string) =>
    setSort((s) => ({ key, dir: s.key === key ? ((-s.dir as 1 | -1) ) : 1 }));
  return { sort, setSort, toggle };
}

export type SortValue = string | number | null | undefined;

/** Sort helper that keeps nulls last regardless of direction. */
export function sortRows<R>(
  rows: R[],
  key: string,
  dir: 1 | -1,
  accessor: (row: R, key: string) => SortValue,
): R[] {
  return rows.slice().sort((a, b) => {
    const va = accessor(a, key);
    const vb = accessor(b, key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return va.localeCompare(String(vb)) * dir;
    return ((va as number) - (vb as number)) * dir;
  });
}

export interface DataTableProps<R> {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R, i: number) => string;
  empty?: ReactNode;
  sort?: SortState;
  onSort?: (key: string) => void;
  /** Makes the whole row a link. Clicks on nested links/buttons still win. */
  rowHref?: (row: R) => string;
  /** Cell contents keyed by column key, rendered in a totals row. */
  footer?: Record<string, ReactNode>;
  /** Extra class on a row — used for the grouped/selected variants. */
  rowClass?: (row: R) => string;
  /**
   * Bands the rows: a full-width header row is drawn wherever this changes.
   * Rows must already be in group order — the table does not sort them.
   */
  groupOf?: (row: R) => string;
  /** What the band says. Given the group key and how many rows are in it. */
  groupLabel?: (key: string, count: number) => ReactNode;
}

export function DataTable<R>({
  columns, rows, rowKey, empty, sort, onSort, rowHref, footer, rowClass, groupOf, groupLabel,
}: DataTableProps<R>) {
  const navigate = useNavigate();
  // Density is an account preference rather than a prop, so every table in the
  // product follows it without each page having to remember to pass it down.
  usePrefsVersion();
  const dense = PREFS.denseTables();

  if (!rows.length) {
    return (
      <>
        {empty || (
          <div className="card">
            <EmptyState title="Nothing to show" body="No rows match the current filters." />
          </div>
        )}
      </>
    );
  }

  const groupCount = new Map<string, number>();
  if (groupOf) rows.forEach((r) => groupCount.set(groupOf(r), (groupCount.get(groupOf(r)) || 0) + 1));

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className={dense ? 'tbl is-dense' : 'tbl'}>
          <thead>
            <tr>
              {columns.map((c) => {
                const sortable = !!c.sortKey && !!onSort;
                const active = c.sortKey && sort && sort.key === c.sortKey;
                return (
                  <th
                    key={c.key}
                    className={sortable ? 'is-sortable' : undefined}
                    style={c.align ? { textAlign: c.align } : undefined}
                    aria-sort={
                      c.sortKey
                        ? active
                          ? sort!.dir === 1
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                        : undefined
                    }
                    {...(sortable
                      ? {
                          tabIndex: 0,
                          role: 'button',
                          onClick: () => onSort!(c.sortKey!),
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onSort!(c.sortKey!);
                            }
                          },
                        }
                      : {})}
                  >
                    {c.label}
                    {active ? (sort!.dir === 1 ? ' ↑' : ' ↓') : ''}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const g = groupOf?.(r);
              const band = groupOf && (i === 0 || groupOf(rows[i - 1]) !== g) ? (
                <tr key={`group-${g}`} className="group-row">
                  <td colSpan={columns.length}>
                    {groupLabel ? groupLabel(g!, groupCount.get(g!) || 0) : g}
                  </td>
                </tr>
              ) : null;
              return [band,
              <tr
                key={rowKey(r, i)}
                className={rowClass?.(r)}
                style={rowHref ? { cursor: 'pointer' } : undefined}
                onClick={
                  rowHref
                    ? (e) => {
                        if (!(e.target as HTMLElement).closest('a,button,input,select')) {
                          navigate(rowHref(r));
                        }
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    style={c.align ? { textAlign: c.align } : undefined}
                    className={c.nowrap ? 'whitespace-nowrap' : undefined}
                  >
                    {c.cell(r)}
                  </td>
                ))}
              </tr>,
              ];
            })}
          </tbody>
          {footer ? (
            <tfoot>
              <tr>
                {columns.map((c) => (
                  <td key={c.key} style={c.align ? { textAlign: c.align } : undefined}>
                    {footer[c.key] ?? ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </div>
  );
}
