import type { IReport } from '@openpanel/core/modules/report/report.constants';
import { describe, expect, test } from 'vitest';
import reducer, {
  changeChartType,
  changeConversionYAxisScale,
  changeFunnelWindow,
  changeSankeyLabelBy,
  changeSankeySteps,
  removeEvent,
  setReport,
} from './reportSlice';

const event = (id: string) => ({
  id,
  type: 'event' as const,
  name: id,
  segment: 'event' as const,
  filters: [],
});

function funnelWithStep(step: number) {
  return reducer(
    undefined,
    setReport({
      projectId: 'project',
      name: 'Funnel',
      chartType: 'funnel',
      lineType: 'monotone',
      interval: 'day',
      range: '30d',
      previous: false,
      metric: 'sum',
      series: [event('a'), event('b'), event('c')],
      breakdowns: [{ id: 'b0', name: 'properties.variant', step }],
    } as IReport)
  );
}

describe('breakdown step', () => {
  test('is cleared when removing a series leaves it past the last step', () => {
    const state = reducer(funnelWithStep(3), removeEvent({ id: 'c' }));
    expect(state.breakdowns[0]?.step).toBeUndefined();
  });

  test('is kept while it still points at a step', () => {
    const state = reducer(funnelWithStep(2), removeEvent({ id: 'c' }));
    expect(state.breakdowns[0]?.step).toBe(2);
  });
});

describe('conversion y-axis scale', () => {
  test('lives on the funnel options next to the funnel window', () => {
    const withWindow = reducer(funnelWithStep(2), changeFunnelWindow(48));
    const state = reducer(withWindow, changeConversionYAxisScale('auto'));
    expect(state.options).toEqual({
      type: 'funnel',
      funnelGroup: undefined,
      funnelWindow: 48,
      yAxisScale: 'auto',
    });
  });

  test('is unset for the fixed default', () => {
    const auto = reducer(funnelWithStep(2), changeConversionYAxisScale('auto'));
    const state = reducer(auto, changeConversionYAxisScale(undefined));
    expect(state.options?.type).toBe('funnel');
    expect(
      state.options?.type === 'funnel' ? state.options.yAxisScale : 'wrong'
    ).toBeUndefined();
  });
});

describe('sankey label-by', () => {
  const defaultRule = { event: 'screen_view', property: 'path' };

  test('seeds screen_view -> path when switching a report to sankey', () => {
    const state = reducer(undefined, changeChartType('sankey'));
    expect(
      state.options?.type === 'sankey' ? state.options.labelBy : 'wrong'
    ).toEqual([defaultRule]);
  });

  test('seeds the default when another sankey reducer creates the options', () => {
    const state = reducer(undefined, changeSankeySteps(3));
    expect(
      state.options?.type === 'sankey' ? state.options.labelBy : 'wrong'
    ).toEqual([defaultRule]);
  });

  test('does not share the seeded array between reports', () => {
    const a = reducer(undefined, changeChartType('sankey'));
    const b = reducer(undefined, changeChartType('sankey'));
    const rulesA = a.options?.type === 'sankey' ? a.options.labelBy : undefined;
    const rulesB = b.options?.type === 'sankey' ? b.options.labelBy : undefined;
    expect(rulesA).not.toBe(rulesB);
  });

  test('changeSankeyLabelBy replaces the rules and marks the report dirty', () => {
    const seeded = reducer(undefined, changeChartType('sankey'));
    const state = reducer(
      { ...seeded, dirty: false },
      changeSankeyLabelBy([{ event: 'click', property: 'target' }])
    );
    expect(state.dirty).toBe(true);
    expect(
      state.options?.type === 'sankey' ? state.options.labelBy : 'wrong'
    ).toEqual([{ event: 'click', property: 'target' }]);
  });

  test('changeSankeyLabelBy can clear all rules', () => {
    const seeded = reducer(undefined, changeChartType('sankey'));
    const state = reducer(seeded, changeSankeyLabelBy([]));
    expect(
      state.options?.type === 'sankey' ? state.options.labelBy : 'wrong'
    ).toEqual([]);
  });

  test('changeSankeyLabelBy creates sankey options when none exist', () => {
    const state = reducer(
      undefined,
      changeSankeyLabelBy([{ event: 'a', property: 'path' }])
    );
    expect(state.options).toMatchObject({
      type: 'sankey',
      labelBy: [{ event: 'a', property: 'path' }],
    });
  });
});
