// @vitest-environment jsdom

import type { IServiceEvent } from '@openpanel/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { useColumns } from './columns';

vi.mock('../use-event-drawer', () => ({
  useEventDrawer: () => ({ openEvent: vi.fn() }),
}));
vi.mock('@/hooks/use-numer-formatter', () => ({
  useNumber: () => ({ currency: (n: number) => String(n) }),
}));
vi.mock('@/modals', () => ({ pushModal: vi.fn() }));
vi.mock('@/components/links', () => ({
  ProjectLink: ({
    children,
    params,
    to,
  }: {
    children: React.ReactNode;
    params?: Record<string, string>;
    to?: string;
  }) => (
    <a data-params={JSON.stringify(params)} data-to={to} href="/x">
      {children}
    </a>
  ),
}));

afterEach(cleanup);

function getColumns() {
  let columns: ReturnType<typeof useColumns> = [];
  const Probe = () => {
    columns = useColumns();
    return null;
  };
  render(<Probe />);
  return columns;
}

const findColumn = (id: string) => {
  const column = getColumns().find((c) => c.id === id);
  if (!column) {
    throw new Error(`column ${id} not found`);
  }
  return column;
};

const mount = (node: unknown) => render(node as React.ReactElement);

const renderCell = (id: string, original: Partial<IServiceEvent>) => {
  const column = findColumn(id);
  const cell = column.cell as (ctx: { row: { original: unknown } }) => unknown;
  return cell({ row: { original } });
};

describe('events table identity columns', () => {
  test.each(['profileIdRaw', 'mobile_no'])('%s is hidden by default', (id) => {
    expect(findColumn(id).meta?.hidden).toBe(true);
  });

  test('profileIdRaw prefers profile.id over event profileId', () => {
    const column = findColumn('profileIdRaw') as unknown as {
      accessorFn: (row: unknown) => unknown;
    };
    expect(column.accessorFn({ profile: { id: 'p1' }, profileId: 'raw' })).toBe(
      'p1'
    );
    expect(column.accessorFn({ profileId: 'raw' })).toBe('raw');
  });

  test('profileIdRaw renders a profile link and falls back to profileId', () => {
    mount(
      renderCell('profileIdRaw', {
        profile: { id: 'p1' } as never,
        profileId: 'raw',
      })
    );
    const link = screen.getByText('p1');
    expect(link.getAttribute('data-to')).toBe('/profiles/$profileId');
    expect(link.getAttribute('data-params')).toBe('{"profileId":"p1"}');
    cleanup();

    mount(renderCell('profileIdRaw', { profileId: 'raw' }));
    expect(screen.getByText('raw')).toBeTruthy();
  });

  test('profileIdRaw renders nothing without any id', () => {
    expect(renderCell('profileIdRaw', {})).toBeNull();
  });

  test('mobile_no renders profile.properties.mobile_no', () => {
    mount(
      renderCell('mobile_no', {
        profile: { properties: { mobile_no: '+911234567890' } } as never,
      })
    );
    expect(screen.getByText('+911234567890')).toBeTruthy();
  });

  test('mobile_no renders nothing when the trait is missing', () => {
    expect(renderCell('mobile_no', {})).toBeNull();
    expect(
      renderCell('mobile_no', { profile: { properties: {} } as never })
    ).toBeNull();
  });
});
