// @vitest-environment jsdom

// FORK (ToHands): the Sankey "Node label" rule editor. The comboboxes are
// stubbed to plain buttons so the test drives the editor's own logic: which
// rules it dispatches for add / edit / remove.

import type { ISankeyLabelRule } from '@openpanel/core/modules/report/report.constants';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { changeSankeyLabelBy } from '../reportSlice';
import { SankeyLabelBy } from './SankeyLabelBy';

const dispatch = vi.fn();

vi.mock('@/redux', () => ({ useDispatch: () => dispatch }));
vi.mock('@/hooks/use-app-params', () => ({
  useAppParams: () => ({ projectId: 'proj' }),
}));
vi.mock('@/hooks/use-event-names', () => ({
  useEventNames: () => [
    { name: '*' },
    { name: 'screen_view' },
    { name: 'tap' },
  ],
}));
vi.mock('@/components/ui/combobox-events', () => ({
  ComboboxEvents: ({
    items,
    onChange,
    value,
  }: {
    items: { name: string }[];
    onChange: (value: string) => void;
    value: string | null;
  }) => (
    <div
      data-items={items.map((i) => i.name).join(',')}
      data-testid="event-picker"
    >
      <span>{value ?? 'Event'}</span>
      <button onClick={() => onChange('tap')} type="button">
        pick tap
      </button>
    </div>
  ),
}));
vi.mock('./PropertiesCombobox', () => ({
  PropertiesCombobox: ({
    children,
    onSelect,
  }: {
    children: (setOpen: (open: boolean) => void) => React.ReactNode;
    onSelect: (action: { value: string }) => void;
  }) => (
    <div>
      {children(() => undefined)}
      <button
        onClick={() => onSelect({ value: 'properties.screen' })}
        type="button"
      >
        pick screen
      </button>
    </div>
  ),
}));

const RULES: ISankeyLabelRule[] = [
  { event: 'screen_view', property: 'path' },
  { event: '', property: '' },
];

beforeEach(() => dispatch.mockClear());
afterEach(cleanup);

const lastDispatched = () => dispatch.mock.lastCall?.[0];

describe('SankeyLabelBy', () => {
  test('renders one row per rule with a placeholder for an unset property', () => {
    render(<SankeyLabelBy value={RULES} />);

    expect(screen.getAllByTestId('event-picker')).toHaveLength(2);
    expect(screen.getByText('screen_view')).toBeTruthy();
    expect(screen.getByText('path')).toBeTruthy();
    expect(screen.getByText('Select property')).toBeTruthy();
  });

  test('hides the "*" wildcard from the event picker', () => {
    render(<SankeyLabelBy value={RULES.slice(0, 1)} />);

    expect(screen.getByTestId('event-picker').dataset.items).toBe(
      'screen_view,tap'
    );
  });

  test('adds a rule defaulting to path with no event', () => {
    render(<SankeyLabelBy value={RULES.slice(0, 1)} />);

    fireEvent.click(screen.getByText('Add label rule'));

    expect(lastDispatched()).toEqual(
      changeSankeyLabelBy([
        { event: 'screen_view', property: 'path' },
        { event: '', property: 'path' },
      ])
    );
  });

  test('edits only the row that changed', () => {
    render(<SankeyLabelBy value={RULES} />);

    fireEvent.click(screen.getAllByText('pick tap')[1]!);
    expect(lastDispatched()).toEqual(
      changeSankeyLabelBy([RULES[0]!, { event: 'tap', property: '' }])
    );

    fireEvent.click(screen.getAllByText('pick screen')[0]!);
    expect(lastDispatched()).toEqual(
      changeSankeyLabelBy([
        { event: 'screen_view', property: 'properties.screen' },
        RULES[1]!,
      ])
    );
  });

  test('removes a rule', () => {
    render(<SankeyLabelBy value={RULES} />);

    fireEvent.click(screen.getAllByLabelText('Remove label rule')[0]!);

    expect(lastDispatched()).toEqual(changeSankeyLabelBy([RULES[1]!]));
  });

  test('keeps duplicate rows distinct', () => {
    const duplicate = { event: 'tap', property: 'path' };
    render(<SankeyLabelBy value={[duplicate, duplicate]} />);

    fireEvent.click(screen.getAllByLabelText('Remove label rule')[1]!);

    expect(lastDispatched()).toEqual(changeSankeyLabelBy([duplicate]));
  });
});
