// @vitest-environment jsdom

// FORK (ToHands): the Sankey "Node label" section of the report settings.

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ReportSettings } from './ReportSettings';

const reportState = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock('@/redux', () => ({
  useDispatch: () => vi.fn(),
  useSelector: (select: (state: { report: unknown }) => unknown) =>
    select({ report: reportState.current }),
}));
vi.mock('@/hooks/use-app-params', () => ({
  useAppParams: () => ({ projectId: 'proj' }),
}));
vi.mock('@/hooks/use-event-names', () => ({ useEventNames: () => [] }));
vi.mock('./SankeyLabelBy', () => ({
  SankeyLabelBy: ({ value }: { value: unknown[] }) => (
    <div data-testid="label-by">{value.length} rules</div>
  ),
}));

afterEach(cleanup);

const sankeyReport = (labelBy?: unknown[]) => ({
  chartType: 'sankey',
  previous: false,
  series: [],
  options: { type: 'sankey', mode: 'after', steps: 5, exclude: [], labelBy },
});

describe('ReportSettings — Sankey node label', () => {
  test('renders the label-by editor with the report rules', () => {
    reportState.current = sankeyReport([
      { event: 'screen_view', property: 'path' },
    ]);
    render(<ReportSettings />);

    expect(screen.getByText('Node label')).toBeTruthy();
    expect(screen.getByTestId('label-by').textContent).toBe('1 rules');
  });

  test('passes no rules for a saved report without labelBy', () => {
    reportState.current = sankeyReport(undefined);
    render(<ReportSettings />);

    expect(screen.getByTestId('label-by').textContent).toBe('0 rules');
  });

  test('is not shown for other chart types', () => {
    reportState.current = { chartType: 'linear', previous: false, series: [] };
    render(<ReportSettings />);

    expect(screen.queryByText('Node label')).toBeNull();
  });
});
