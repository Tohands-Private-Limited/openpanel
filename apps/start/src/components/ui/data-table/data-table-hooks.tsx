import type {
  ColumnDef,
  PaginationState,
  VisibilityState,
} from '@tanstack/react-table';
import { parseAsInteger, useQueryState } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';
import { useLocalStorage, useReadLocalStorage } from 'usehooks-ts';

export const useDataTablePagination = (pageSize = 10) => {
  const [page, setPage] = useQueryState(
    'page',
    parseAsInteger.withDefault(1).withOptions({
      clearOnDefault: true,
      history: 'push',
    }),
  );
  const state: PaginationState = {
    pageIndex: page - 1,
    pageSize: pageSize,
  };
  return { page, setPage, state };
};

export const useReadColumnVisibility = (persistentKey: string) => {
  return useReadLocalStorage<Record<string, boolean>>(
    `@op:${persistentKey}-column-visibility`,
  );
};

export const useDataTableColumnVisibility = <TData,>(
  columns: ColumnDef<TData>[],
  persistentKey: string,
) => {
  // Default visibility derived from each column's `meta.hidden`
  // (hidden: true => not visible; columns without the flag default to visible).
  const defaultColumnVisibility = columns.reduce((acc, column) => {
    // Use accessorKey as fallback if id is not provided
    const columnId = column.id || (column as any).accessorKey;
    if (columnId) {
      acc[columnId] =
        typeof column.meta?.hidden === 'boolean'
          ? !column.meta?.hidden
          : true;
    }
    return acc;
  }, {} as VisibilityState);

  const [storedColumnVisibility, setColumnVisibility] = useLocalStorage<
    Record<string, boolean>
  >(`@op:${persistentKey}-column-visibility`, defaultColumnVisibility);

  // Columns introduced after a user's preferences were first persisted are
  // absent from the stored map; TanStack would then default them to visible,
  // ignoring `meta.hidden`. Merge so stored choices win, but new columns fall
  // back to their intended default. Memoized for a stable reference into the
  // table's controlled state.
  const columnVisibility = useMemo(
    () => ({ ...defaultColumnVisibility, ...storedColumnVisibility }),
    [
      JSON.stringify(defaultColumnVisibility),
      JSON.stringify(storedColumnVisibility),
    ],
  );

  // somewhat hack
  // Set initial column visibility,
  // otherwise will not useReadColumnVisibility be updated
  useEffect(() => {
    setColumnVisibility(columnVisibility);
  }, []);

  // Order follows column definition order. Resolve `accessorKey` because
  // accessor-based columns carry no explicit `id` in their def — without this
  // their entries are `undefined`, leaving only columns with an explicit `id`
  // (e.g. the Profile ID / Mobile columns) as valid order entries, which
  // front-loads them in the view menu.
  const [columnOrder, setColumnOrder] = useLocalStorage<string[]>(
    `@op:${persistentKey}-column-order`,
    columns
      .map((column) => column.id || (column as any).accessorKey)
      .filter(Boolean) as string[],
  );

  return { columnVisibility, setColumnVisibility, columnOrder, setColumnOrder };
};
