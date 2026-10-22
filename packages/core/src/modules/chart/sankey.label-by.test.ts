import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createClient } from '@openpanel/db/src/clickhouse/client';
import { bootstrapTestDatabases } from '../../../../../test/bootstrap-databases';
import { TEST_CLICKHOUSE_URL } from '../../../../../test/databases';
import { buildEvent } from '../../../../../test/fixtures';
import { testServiceDeps } from '../../../test/service-deps';
import type { ServiceDeps } from '../../services';
import {
  type ISankeyLabelRule,
  zReportInput,
  zSankeyOptions,
} from '../report/report.constants';
import { getSankeyChart } from './chart.service';
import {
  getSankey,
  getUserFlowCore,
  type SankeyResult,
} from './sankey.service';
import {
  type SankeyPathsInput,
  sankeyBetweenTopEntriesQuery,
  sankeyBetweenTransitionsQuery,
  sankeyTopEntriesQuery,
  sankeyTransitionsQuery,
} from './src/sankey.sql';
import { buildSankeyLabelExpr } from './src/sankey-labels';

/**
 *   session  events, in order
 *   s1       session_start, screen_view /home, screen_view /pricing, signup
 *   s2       session_start, screen_view /home, screen_view /docs, signup
 *   s3       session_start, screen_view /home, screen_view /pricing, signup
 *   s4       session_start, screen_view /pricing, signup
 *   s5       session_start, screen_view (no path), signup
 */
const PROJECT_ID = 'test-sankey-label-by';
const START = '2024-03-04 00:00:00';
const END = '2024-03-04 23:59:59';
const STEPS = 5;

const JOURNEYS: Record<string, string[]> = {
  s1: ['session_start', '/home', '/pricing', 'signup'],
  s2: ['session_start', '/home', '/docs', 'signup'],
  s3: ['session_start', '/home', '/pricing', 'signup'],
  s4: ['session_start', '/pricing', 'signup'],
  s5: ['session_start', '', 'signup'],
};

const SCREEN_VIEW_BY_PATH: ISankeyLabelRule[] = [
  { event: 'screen_view', property: 'path' },
];

function isScreenView(step: string): boolean {
  return step === '' || step.startsWith('/');
}

function buildEvents() {
  return Object.entries(JOURNEYS).flatMap(([session, journey]) =>
    journey.map((step, index) =>
      buildEvent(
        new Date(),
        PROJECT_ID,
        crypto.randomUUID(),
        isScreenView(step) ? 'screen_view' : step,
        `profile-${session}`,
        `session-${session}`,
        0,
        0,
        {
          created_at: `2024-03-04 10:0${index}:00`,
          path: isScreenView(step) ? step : '/',
        }
      )
    )
  );
}

function chartEvent(name: string) {
  return {
    id: name,
    name,
    displayName: name,
    type: 'event' as const,
    segment: 'event' as const,
    filters: [],
  };
}

function flow(
  input: Partial<Parameters<typeof getSankey>[1]>
): Promise<SankeyResult> {
  return getSankey(deps, {
    projectId: PROJECT_ID,
    startDate: START,
    endDate: END,
    steps: STEPS,
    mode: 'after',
    startEvent: chartEvent('session_start'),
    exclude: [],
    labelBy: [],
    timezone: 'UTC',
    ...input,
  });
}

function nodeValues(result: SankeyResult): Record<string, number | undefined> {
  return Object.fromEntries(result.nodes.map((node) => [node.id, node.value]));
}

let deps: ServiceDeps;

async function withClient(
  run: (client: ReturnType<typeof createClient>) => Promise<unknown>
) {
  const client = createClient({ url: TEST_CLICKHOUSE_URL });
  try {
    await run(client);
  } finally {
    await client.close();
  }
}

describe('buildSankeyLabelExpr', () => {
  it('is the bare event name without rules', () => {
    expect(buildSankeyLabelExpr([]).toStatement().query).toBe('name');
  });

  it('binds the event name and resolves the property through the shared resolver', () => {
    const { query, query_params } = buildSankeyLabelExpr([
      { event: "it's", property: 'properties.status' },
    ]).toStatement();

    expect(query).toContain('multiIf(name = {p');
    expect(query).toContain('properties[{p');
    expect(query).not.toContain("it's");
    expect(Object.values(query_params)).toEqual(["it's", 'status']);
  });

  it('chains several rules into one multiIf that falls back to the name', () => {
    const { query } = buildSankeyLabelExpr([
      ...SCREEN_VIEW_BY_PATH,
      { event: 'video_play', property: 'properties.video_id' },
    ]).toStatement();

    expect(query.startsWith('multiIf(')).toBe(true);
    expect(query.endsWith(', name)')).toBe(true);
    expect(query.match(/name = \{p/g)).toHaveLength(2);
  });

  it('drops incomplete, join-requiring, unknown and wildcard rules', () => {
    for (const rule of [
      { event: 'screen_view', property: '' },
      { event: '', property: 'path' },
      { event: 'screen_view', property: 'profile.email' },
      { event: 'screen_view', property: 'group.type' },
      { event: 'screen_view', property: 'cohort:abc' },
      { event: 'screen_view', property: 'temple_name' },
      { event: 'screen_view', property: 'properties.items.*.id' },
    ]) {
      expect(buildSankeyLabelExpr([rule]).toStatement().query).toBe('name');
    }
  });
});

describe('sankey statements without an applicable rule', () => {
  const anchor = { name: 'screen_view', whereClause: null };
  const end = { name: 'signup', whereClause: null };

  function statements(labelBy: ISankeyLabelRule[]): string[] {
    return (['after', 'before', 'between'] as const).flatMap((mode) => {
      const input: SankeyPathsInput = {
        projectId: PROJECT_ID,
        startDate: START,
        endDate: END,
        steps: STEPS,
        mode,
        startEvent: anchor,
        endEvent: end,
        exclude: [],
        labelBy,
      };
      return [
        sankeyTopEntriesQuery(input),
        sankeyTransitionsQuery(input, ['a']),
        sankeyBetweenTopEntriesQuery(input, anchor, end),
        sankeyBetweenTransitionsQuery(input, anchor, end, ['a']),
      ].map((fragment) => JSON.stringify(fragment.toStatement()));
    });
  }

  it('keep single-name path elements, as upstream', () => {
    const plain = statements([]);
    expect(
      statements([{ event: 'screen_view', property: 'profile.email' }])
    ).toEqual(plain);
    for (const statement of plain) {
      expect(statement).toContain('groupArray(event_name)');
      expect(statement).not.toContain('].2');
      expect(statement).not.toContain('x.1');
    }
  });

  it('switch to (name, label) tuples once a rule applies', () => {
    for (const statement of statements(SCREEN_VIEW_BY_PATH)) {
      expect(statement).toContain('groupArray((name, label))');
      expect(statement).not.toContain('event_name');
    }
  });
});

describe('zSankeyOptions labelBy', () => {
  const base = { type: 'sankey', mode: 'after', steps: STEPS, exclude: [] };

  it('is absent for saved reports that predate it', () => {
    expect(zSankeyOptions.parse(base).labelBy).toBeUndefined();
  });

  it('keeps event-level rules', () => {
    expect(
      zSankeyOptions.parse({ ...base, labelBy: SCREEN_VIEW_BY_PATH }).labelBy
    ).toEqual(SCREEN_VIEW_BY_PATH);
  });

  it('refuses join-requiring properties', () => {
    for (const property of ['profile.email', 'group.type', 'cohort:abc']) {
      expect(
        zSankeyOptions.safeParse({
          ...base,
          labelBy: [{ event: 'screen_view', property }],
        }).success
      ).toBe(false);
    }
  });
});

describe('getSankey with node label rules', () => {
  beforeAll(async () => {
    // The file may be the first to touch ClickHouse in its shard.
    await bootstrapTestDatabases();
    deps = await testServiceDeps();
    await withClient(async (client) => {
      await client.command({
        query: `DELETE FROM events WHERE project_id = '${PROJECT_ID}'`,
      });
      await client.insert({
        table: 'events',
        values: buildEvents(),
        format: 'JSONEachRow',
      });
    });
  });

  afterAll(async () => {
    await withClient((client) =>
      client.command({
        query: `DELETE FROM events WHERE project_id = '${PROJECT_ID}'`,
      })
    );
  });

  // An unmerged terminal node is dropped by the flow builder, so `signup` is absent here.
  it('groups every screen_view into one node without rules', async () => {
    expect(nodeValues(await flow({}))).toEqual({
      'session_start::step1': 5,
      'screen_view::step2': 5,
    });
  });

  it('splits screen_view by path, falling back to the name for an empty path', async () => {
    const result = await flow({ labelBy: SCREEN_VIEW_BY_PATH });

    expect(nodeValues(result)).toEqual({
      'session_start::step1': 5,
      '/home::step2': 3,
      '/pricing::step2': 1,
      'screen_view::step2': 1,
      '/pricing::step3': 2,
      '/docs::step3': 1,
      'signup::final': 5,
    });
    expect(result.links).toContainEqual({
      source: '/home::step2',
      target: '/pricing::step3',
      value: 2,
    });
  });

  it('still anchors on the event name when that event is relabelled', async () => {
    const result = await flow({
      startEvent: chartEvent('screen_view'),
      labelBy: SCREEN_VIEW_BY_PATH,
    });

    const entries = result.nodes
      .filter((node) => node.step === 1)
      .map((node) => [node.label, node.value]);
    expect(Object.fromEntries(entries)).toEqual({
      '/home': 3,
      '/pricing': 1,
      screen_view: 1,
    });
  });

  it('labels the stretch between two anchors in between mode', async () => {
    const result = await flow({
      mode: 'between',
      startEvent: chartEvent('screen_view'),
      endEvent: chartEvent('signup'),
      labelBy: SCREEN_VIEW_BY_PATH,
    });

    expect(nodeValues(result)).toEqual({
      '/home::step1': 3,
      '/pricing::step1': 1,
      'screen_view::step1': 1,
      '/pricing::step2': 2,
      '/docs::step2': 1,
      'signup::final': 5,
    });
  });

  it('labels the path leading up to the anchor in before mode', async () => {
    const result = await flow({
      mode: 'before',
      startEvent: chartEvent('signup'),
      labelBy: SCREEN_VIEW_BY_PATH,
    });

    expect(nodeValues(result)).toEqual({
      'session_start::step1': 5,
      '/home::step2': 3,
      '/pricing::step2': 1,
      'screen_view::step2': 1,
      '/pricing::step3': 2,
      '/docs::step3': 1,
      'signup::final': 5,
    });
  });

  it('ignores a rule on an unknown column instead of failing the query', async () => {
    expect(
      await flow({ labelBy: [{ event: 'screen_view', property: 'nope' }] })
    ).toEqual(await flow({}));
  });

  describe('entry points pass labelBy through', () => {
    // The fixture project lives only in ClickHouse; answer the timezone lookup.
    const withProjectSettings = (): ServiceDeps => {
      const db = new Proxy(deps.db, {
        get: (target, key) =>
          key === 'project'
            ? {
                findUniqueOrThrow: async () => ({
                  organization: { id: 'org', timezone: 'UTC' },
                }),
              }
            : Reflect.get(target, key),
      });
      return new Proxy(deps, {
        get: (target, key) => (key === 'db' ? db : Reflect.get(target, key)),
      });
    };

    it('getSankeyChart reads the saved report options', async () => {
      const input = zReportInput.parse({
        projectId: PROJECT_ID,
        startDate: START,
        endDate: END,
        range: 'custom',
        chartType: 'sankey',
        interval: 'day',
        breakdowns: [],
        series: [{ ...chartEvent('session_start'), id: 'A' }],
        options: {
          type: 'sankey',
          mode: 'after',
          steps: STEPS,
          exclude: [],
          labelBy: SCREEN_VIEW_BY_PATH,
        },
      });

      const result = await getSankeyChart(withProjectSettings(), input);

      expect(nodeValues(result)['/home::step2']).toBe(3);
    });

    it('getUserFlowCore (assistant / MCP) accepts rules too', async () => {
      const result = await getUserFlowCore(withProjectSettings(), {
        projectId: PROJECT_ID,
        startDate: START,
        endDate: END,
        startEvent: 'session_start',
        mode: 'after',
        steps: STEPS,
        labelBy: SCREEN_VIEW_BY_PATH,
      });

      expect(JSON.stringify(result)).toContain('/home');
    });
  });
});
