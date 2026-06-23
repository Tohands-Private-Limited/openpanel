/**
 * Tests for the Sankey/flow service.
 *
 * Two layers:
 *  1. Pure unit tests for `buildSankeyLabelExpr` — the per-event node-labeling
 *     expression (the TH-3935 feature). No ClickHouse needed.
 *  2. Integration tests that actually run `getSankey` against a local CH so the
 *     generated tuple SQL (`groupArray((name, label))`, `x.1`/`x.2` accessors)
 *     is parsed/executed against the real `events` schema. These auto-skip if
 *     CH is unreachable (run `pnpm dock:up` first). They assert shape only, so
 *     they pass even against an empty database.
 */
import { zSankeyOptions } from '@openpanel/validation';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ch } from '../clickhouse/client';
import { buildSankeyLabelExpr, sankeyService } from './sankey.service';

const PROJECT_ID = 'test-sankey-validation';
const START = '2026-04-14 00:00:00';
const END = '2026-05-15 00:00:00';

const chartEvent = (name: string) => ({
  id: name,
  name,
  segment: 'event' as const,
  filters: [],
});

describe('buildSankeyLabelExpr', () => {
  it('returns the bare event name when there are no rules', () => {
    expect(buildSankeyLabelExpr([], PROJECT_ID)).toBe('name');
  });

  it('relabels screen_view by its top-level `path` column with a name fallback', () => {
    const expr = buildSankeyLabelExpr(
      [{ event: 'screen_view', property: 'path' }],
      PROJECT_ID,
    );
    expect(expr).toBe(
      "multiIf(name = 'screen_view', if(empty(toString(path)), name, toString(path)), name)",
    );
  });

  it('resolves a custom event property through the properties map', () => {
    const expr = buildSankeyLabelExpr(
      [{ event: 'permission_used', property: 'properties.status' }],
      PROJECT_ID,
    );
    expect(expr).toContain("name = 'permission_used'");
    expect(expr).toContain("properties['status']");
  });

  it('chains multiple rules into a single multiIf, others keep their name', () => {
    const expr = buildSankeyLabelExpr(
      [
        { event: 'screen_view', property: 'path' },
        { event: 'video_play', property: 'properties.video_id' },
      ],
      PROJECT_ID,
    );
    expect(expr.startsWith('multiIf(')).toBe(true);
    expect(expr.endsWith(', name)')).toBe(true);
    expect(expr).toContain("name = 'screen_view'");
    expect(expr).toContain("name = 'video_play'");
  });

  it('escapes single quotes in event names', () => {
    const expr = buildSankeyLabelExpr(
      [{ event: "weird'name", property: 'path' }],
      PROJECT_ID,
    );
    expect(expr).toContain("name = 'weird''name'");
  });

  it('ignores incomplete rules (missing event or property)', () => {
    expect(
      buildSankeyLabelExpr([{ event: 'screen_view', property: '' }], PROJECT_ID),
    ).toBe('name');
    expect(
      buildSankeyLabelExpr([{ event: '', property: 'path' }], PROJECT_ID),
    ).toBe('name');
  });

  it('defensively skips join-requiring properties (no missing-alias SQL)', () => {
    // profile.*, group.*, cohort:* need a JOIN the flow query lacks.
    for (const property of [
      'profile.email',
      'group.type',
      'cohort:abc-123',
    ]) {
      expect(
        buildSankeyLabelExpr([{ event: 'screen_view', property }], PROJECT_ID),
      ).toBe('name');
    }
  });
});

describe('zSankeyOptions labelBy back-compat', () => {
  it('defaults labelBy to [] for saved reports that predate the field', () => {
    const parsed = zSankeyOptions.parse({
      type: 'sankey',
      mode: 'after',
      steps: 5,
      exclude: [],
    });
    expect(parsed.labelBy).toEqual([]);
  });

  it('accepts and preserves label rules', () => {
    const parsed = zSankeyOptions.parse({
      type: 'sankey',
      mode: 'after',
      steps: 5,
      exclude: [],
      labelBy: [{ event: 'screen_view', property: 'path' }],
    });
    expect(parsed.labelBy).toEqual([{ event: 'screen_view', property: 'path' }]);
  });

  it('rejects join-requiring label properties at the validation boundary', () => {
    for (const property of ['profile.email', 'group.type', 'cohort:abc']) {
      expect(() =>
        zSankeyOptions.parse({
          type: 'sankey',
          mode: 'after',
          steps: 5,
          exclude: [],
          labelBy: [{ event: 'screen_view', property }],
        }),
      ).toThrow();
    }
  });
});

let chReachable = false;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await ch.command({ query: 'SELECT 1' });
    chReachable = true;
  } catch {
    chReachable = false;
  }
});

afterAll(() => {
  vi.restoreAllMocks();
});

const itCH = (name: string, fn: () => Promise<void>) =>
  it(name, async () => {
    if (!chReachable) {
      console.warn(
        '[sankey] skipping: ClickHouse not reachable at CLICKHOUSE_URL',
      );
      return;
    }
    await fn();
  });

describe('sankeyService.getSankey (tuple SQL executes against schema)', () => {
  for (const mode of ['after', 'before'] as const) {
    itCH(`runs mode="${mode}" with a screen_view→path label rule`, async () => {
      const res = await sankeyService.getSankey({
        projectId: PROJECT_ID,
        startDate: START,
        endDate: END,
        steps: 5,
        mode,
        startEvent: chartEvent('screen_view'),
        exclude: [],
        labelBy: [{ event: 'screen_view', property: 'path' }],
        timezone: 'UTC',
      });
      expect(Array.isArray(res.nodes)).toBe(true);
      expect(Array.isArray(res.links)).toBe(true);
    });
  }

  itCH('runs mode="between" with start and end events', async () => {
    const res = await sankeyService.getSankey({
      projectId: PROJECT_ID,
      startDate: START,
      endDate: END,
      steps: 5,
      mode: 'between',
      startEvent: chartEvent('session_start'),
      endEvent: chartEvent('session_end'),
      exclude: [],
      labelBy: [{ event: 'screen_view', property: 'path' }],
      timezone: 'UTC',
    });
    expect(Array.isArray(res.nodes)).toBe(true);
    expect(Array.isArray(res.links)).toBe(true);
  });

  itCH('runs with an empty labelBy (back-compat: label = event name)', async () => {
    const res = await sankeyService.getSankey({
      projectId: PROJECT_ID,
      startDate: START,
      endDate: END,
      steps: 5,
      mode: 'after',
      startEvent: chartEvent('screen_view'),
      exclude: [],
      labelBy: [],
      timezone: 'UTC',
    });
    expect(Array.isArray(res.nodes)).toBe(true);
    expect(Array.isArray(res.links)).toBe(true);
  });
});
