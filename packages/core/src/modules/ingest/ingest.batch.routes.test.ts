/**
 * FORK (ToHands): the HTTP contract of batch ingestion, through the real
 * Elysia routes. Flutter / LVGL SDKs depend on the exact 202 body
 * `{ accepted, rejected: [{ index, reason, error }] }` — pin it here.
 *
 * Client auth, Kafka, geo and salts are mocked (unhoisted, so the routes are
 * imported in `beforeAll`); the hook chain, schemas and service are real.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { stubAppDeps } from '../../../test/http-fixtures';
import type { Buffers } from '../../buffers/create-buffers';
import type { GeoLocation } from '../../clients/geo';
import { TRACK_BATCH_MAX_BODY_BYTES } from './ingest.constants';
import type { IncomingEventPayload } from './src/incoming-event';

const PROJECT_ID = 'proj-batch-routes';
const CLIENT_ID = '33333333-3333-4333-8333-333333333333';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const produced: IncomingEventPayload[] = [];
const produceIncomingEvent = mock(
  async (_config: unknown, payload: IncomingEventPayload) => {
    produced.push(payload);
  }
);
const validateIngestRequest = mock(async () => ({
  ok: true as const,
  client: { id: CLIENT_ID, projectId: PROJECT_ID },
  secretVerified: true,
}));
const getGeoLocation = mock(
  async (): Promise<GeoLocation> => ({
    country: 'IN',
    city: 'Bengaluru',
    region: 'KA',
    longitude: 77,
    latitude: 13,
  })
);
const getAsnInfo = mock(async () => ({
  asn: undefined,
  org: undefined,
  isHosting: false,
}));
const getSalts = mock(async () => ({
  current: 'salt-current',
  previous: 'salt-previous',
}));

const realKafka = { ...(await import('./src/kafka')) };
const realClientAuth = { ...(await import('./src/client-auth')) };
const realSaltService = { ...(await import('../salt/salt.service')) };
mock.module('./src/kafka', () => ({ ...realKafka, produceIncomingEvent }));
mock.module('./src/client-auth', () => ({
  ...realClientAuth,
  validateIngestRequest,
}));
mock.module('../../clients/geo', () => ({ getGeoLocation, getAsnInfo }));
mock.module('../salt/salt.service', () => ({ ...realSaltService, getSalts }));

afterAll(() => {
  mock.module('./src/kafka', () => realKafka);
  mock.module('./src/client-auth', () => realClientAuth);
  mock.module('../salt/salt.service', () => realSaltService);
});

let app: { handle(request: Request): Promise<Response> };
let warnings: () => { payload: unknown; message: unknown }[];

beforeAll(async () => {
  const { ingestRoutes } = await import('./ingest.routes');
  const stub = stubAppDeps();
  stub.deps.config = { ...stub.deps.config, selfHosted: true };
  stub.deps.buffers = {
    session: {
      getExistingSessions: async (_projectId: string, deviceIds: string[]) =>
        deviceIds.map(() => null),
    },
    replay: { add: async () => undefined },
    group: { add: async () => undefined },
  } as unknown as Buffers;
  app = ingestRoutes(stub.deps);
  warnings = () =>
    stub.logger.lines
      .filter((line) => line.level === 'warn')
      .map((line) => ({ payload: line.payload, message: line.message }));
});

const SDK_HEADERS = {
  'content-type': 'application/json',
  'openpanel-client-id': CLIENT_ID,
  'openpanel-client-secret': 'secret',
  'user-agent': 'openpanel-flutter/1.0 (Android 14)',
  'x-client-ip': '81.2.69.142',
};

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  const text = JSON.stringify(body);
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        ...SDK_HEADERS,
        'content-length': String(Buffer.byteLength(text)),
        ...headers,
      },
      body: text,
    })
  );
}

const trackEvent = (
  name: string,
  properties: Record<string, unknown> = {}
) => ({
  type: 'track',
  payload: { name, properties: { __deviceId: 'device-1', ...properties } },
});

describe('POST /track — batch envelope', () => {
  it('answers 202 with exactly { accepted, rejected[] }', async () => {
    produced.length = 0;

    const response = await post('/track', {
      type: 'batch',
      payload: [
        trackEvent('screen_view', { __path: '/home' }),
        { type: 'track', payload: {} },
        trackEvent('tap'),
      ],
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['accepted', 'rejected']);
    expect(body.accepted).toBe(2);
    const rejected = body.rejected as Record<string, unknown>[];
    expect(rejected).toHaveLength(1);
    expect(Object.keys(rejected[0]!).sort()).toEqual([
      'error',
      'index',
      'reason',
    ]);
    expect(rejected[0]).toMatchObject({ index: 1, reason: 'validation' });
    expect(produced.map((payload) => payload.event.name).sort()).toEqual([
      'screen_view',
      'tap',
    ]);
  });

  it('refuses an empty or oversized envelope at the schema', async () => {
    const empty = await post('/track', { type: 'batch', payload: [] });
    expect(empty.status).toBeGreaterThanOrEqual(400);
    expect(empty.status).toBeLessThan(500);

    const tooMany = await post('/track', {
      type: 'batch',
      payload: Array.from({ length: 2001 }, () => trackEvent('e')),
    });
    expect(tooMany.status).toBeGreaterThanOrEqual(400);
    expect(tooMany.status).toBeLessThan(500);
  });

  it('lets a batch past the single-event Kafka cap but not past the batch cap', async () => {
    const twoMegabytes = String(2 * 1024 * 1024);
    const batch = await post(
      '/track',
      { type: 'batch', payload: [trackEvent('e')] },
      { 'content-length': twoMegabytes }
    );
    expect(batch.status).toBe(202);

    const single = await post('/track', trackEvent('e'), {
      'content-length': twoMegabytes,
    });
    expect(single.status).toBe(413);

    const overBatchCap = await post(
      '/track',
      { type: 'batch', payload: [trackEvent('e')] },
      { 'content-length': String(TRACK_BATCH_MAX_BODY_BYTES + 1) }
    );
    expect(overBatchCap.status).toBe(413);
  });
});

describe('POST /track — single event', () => {
  it('keeps the 200 { deviceId, sessionId } contract', async () => {
    const response = await post('/track', trackEvent('tap'));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.deviceId).toBe('device-1');
    expect(typeof body.sessionId).toBe('string');
  });

  it('refuses an event older than 5 days with 400', async () => {
    const response = await post(
      '/track',
      trackEvent('old', {
        __timestamp: new Date(Date.now() - 6 * DAY_MS).toISOString(),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      message: 'event timestamp older than 5 days',
    });
  });
});

describe('POST /track/batch (deprecated)', () => {
  it('answers like the envelope and logs the deprecated call', async () => {
    const response = await post('/track/batch', {
      events: [trackEvent('a'), { type: 'alias', payload: {} }],
    });

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: number;
      rejected: { index: number }[];
    };
    expect(body.accepted).toBe(1);
    expect(body.rejected.map((rejection) => rejection.index)).toEqual([1]);
    expect(
      warnings().some(
        (line) =>
          (line.payload as { deprecatedEndpoint?: string })
            ?.deprecatedEndpoint === 'POST /track/batch'
      )
    ).toBe(true);
  });
});
