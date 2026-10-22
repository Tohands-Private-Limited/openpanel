// @vitest-environment jsdom

import type { ColumnDef } from '@tanstack/react-table';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { useDataTableColumnVisibility } from './data-table-hooks';

interface Row {
  a: string;
}

const COLUMNS: ColumnDef<Row>[] = [
  { accessorKey: 'a', header: 'A' },
  { id: 'extra', header: 'Extra', meta: { hidden: true } },
  { id: 'shown', header: 'Shown' },
];

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('useDataTableColumnVisibility', () => {
  test('honours meta.hidden by default', () => {
    const { result } = renderHook(() =>
      useDataTableColumnVisibility(COLUMNS, 't1')
    );
    expect(result.current.columnVisibility).toEqual({
      a: true,
      extra: false,
      shown: true,
    });
  });

  test('columns missing from stored prefs fall back to their default', () => {
    localStorage.setItem(
      '@op:t2-column-visibility',
      JSON.stringify({ a: false, shown: true })
    );
    const { result } = renderHook(() =>
      useDataTableColumnVisibility(COLUMNS, 't2')
    );
    expect(result.current.columnVisibility).toEqual({
      a: false,
      extra: false,
      shown: true,
    });
  });

  test('stored choices win over defaults', () => {
    localStorage.setItem(
      '@op:t3-column-visibility',
      JSON.stringify({ a: true, extra: true, shown: true })
    );
    const { result } = renderHook(() =>
      useDataTableColumnVisibility(COLUMNS, 't3')
    );
    expect(result.current.columnVisibility.extra).toBe(true);
  });

  test('column order follows definition order incl. accessorKey columns', () => {
    const { result } = renderHook(() =>
      useDataTableColumnVisibility(COLUMNS, 't4')
    );
    expect(result.current.columnOrder).toEqual(['a', 'extra', 'shown']);
  });
});
