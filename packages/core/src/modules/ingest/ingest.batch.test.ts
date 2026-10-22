/**
 * FORK (ToHands): batch ingestion, the 5-day historical floor and the
 * historical skip of the live-session lookup. See FORK-PATCHES.md.
 *
 * Geo/ASN and the salts are module-level, so those keep a `mock.module`
 * (unhoisted, hence the `await import` in `beforeAll`).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import { testCoreConfig } from '../../../test/config-fixture';
import type { GeoLocation } from '../../clients/geo';
import type { ITrackHandlerPayload } from './ingest.constants';
import type { IncomingEventPayload } from './src/incoming-event';

const getGeoLocation = mock(
  async (): Promise<GeoLocation> => ({
    country: 'SE',
    city: 'Stockholm',
    region: 'AB',
    longitude: 18,
    latitude: 59,
  })
);
const getAsnInfo = mock(async () => ({
  asn: undefined,
  org: undefined,
  isHosting: false,
}));
const getSalts = mock(async (_deps: unknown) => ({
  current: 'salt-current',
  previous: 'salt-previous',
}));

mock.module('../../clients/geo', () => ({ getGeoLocation, getAsnInfo }));

let service: typeof import('./ingest.service');
let realSaltService: typeof import('../salt/salt.service');
beforeAll(async () => {
  realSaltService = { ...(await import('../salt/salt.service')) };
  mock.module('../salt/salt.service', () => ({
    ...realSaltService,
    getSalts,
  }));
  service = await import('./ingest.service');
});

afterAll(() => {
  mock.module('../salt/salt.service', () => realSaltService);
});

const PROJECT_ID = 'proj-batch';
const ARRIVED_AT = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MAX_MESSAGE_BYTES = 4096;

const getExistingSessions = mock(
  async (_projectId: string, deviceIds: string[]) => deviceIds.map(() => null)
);
const loggedErrors: unknown[] = [];

function transport(produce: (payload: IncomingEventPayload) => Promise<void>) {
  const config = testCoreConfig();
  return {
    buffers: {
      session: { getExistingSessions },
      replay: { add: mock(async () => undefined) },
      group: { add: mock(async () => undefined) },
    },
    produceIncomingEvent: produce,
    deps: {
      buffers: {},
      config: {
        ...config,
        kafka: { ...config.kafka, maxMessageBytes: MAX_MESSAGE_BYTES },
      },
      logger: {
        error: (details: unknown) => {
          loggedErrors.push(details);
        },
      },
    },
  } as unknown as Parameters<typeof service.ingestTrackBatch>[1];
}

function recordingProducer() {
  const produced: IncomingEventPayload[] = [];
  const produce = mock(async (payload: IncomingEventPayload) => {
    produced.push(payload);
  });
  return { produced, produce };
}

const baseRequest = {
  projectId: PROJECT_ID,
  clientIp: '1.2.3.4',
  clientSecretAuth: false,
  timestamp: ARRIVED_AT,
  headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/148.0.0.0' },
};

const trackEvent = (
  name: string,
  properties: Record<string, unknown> = {}
): ITrackHandlerPayload => ({
  type: 'track',
  payload: { name, properties: { __deviceId: 'device-1', ...properties } },
});

const atAge = (ageMs: number) => new Date(ARRIVED_AT - ageMs).toISOString();

beforeEach(() => {
  getExistingSessions.mockClear();
  loggedErrors.length = 0;
});

describe('ingestTrackBatch', () => {
  it('accepts every valid event and produces each one to Kafka', async () => {
    const { produced, produce } = recordingProducer();

    const outcome = await service.ingestTrackBatch(
      {
        ...baseRequest,
        events: [trackEvent('a'), trackEvent('b'), trackEvent('c')],
      },
      transport(produce)
    );

    expect(outcome).toEqual({ status: 'ok', accepted: 3, rejected: [] });
    expect(produced.map((payload) => payload.event.name).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('reports invalid items by index with the first issue and its path, without failing the rest', async () => {
    const { produced, produce } = recordingProducer();

    const outcome = await service.ingestTrackBatch(
      {
        ...baseRequest,
        events: [
          trackEvent('ok-1'),
          { type: 'track', payload: {} },
          { type: 'nope' },
          trackEvent('ok-2'),
        ],
      },
      transport(produce)
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') {
      return;
    }
    expect(outcome.accepted).toBe(2);
    expect(outcome.rejected.map((rejection) => rejection.index)).toEqual([
      1, 2,
    ]);
    expect(outcome.rejected[0]).toMatchObject({
      index: 1,
      reason: 'validation',
    });
    expect(outcome.rejected[0]!.error).toStartWith('payload.name: ');
    expect(outcome.rejected[1]!.reason).toBe('validation');
    expect(produced).toHaveLength(2);
  });

  it('rejects the pipeline refusals (alias, too old) as validation with the single-event message', async () => {
    const { produce } = recordingProducer();

    const outcome = await service.ingestTrackBatch(
      {
        ...baseRequest,
        events: [
          { type: 'alias', payload: { profileId: 'a', alias: 'b' } },
          trackEvent('old', { __timestamp: atAge(6 * DAY_MS) }),
        ],
      },
      transport(produce)
    );

    expect(outcome).toEqual({
      status: 'ok',
      accepted: 0,
      rejected: [
        { index: 0, reason: 'validation', error: 'Alias is not supported' },
        {
          index: 1,
          reason: 'validation',
          error: 'event timestamp older than 5 days',
        },
      ],
    });
    expect(produce).not.toHaveBeenCalled();
  });

  it('rejects an item larger than one Kafka message before producing it', async () => {
    const { produce } = recordingProducer();

    const outcome = await service.ingestTrackBatch(
      {
        ...baseRequest,
        events: [trackEvent('huge', { blob: 'x'.repeat(MAX_MESSAGE_BYTES) })],
      },
      transport(produce)
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') {
      return;
    }
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]!.reason).toBe('validation');
    expect(outcome.rejected[0]!.error).toContain(
      `the limit is ${MAX_MESSAGE_BYTES}`
    );
    expect(produce).not.toHaveBeenCalled();
  });

  it('reports a produce failure as internal so the client retries just that index', async () => {
    let calls = 0;
    const produce = mock(async () => {
      calls++;
      if (calls === 2) {
        throw new Error('kafka unavailable');
      }
    });

    const outcome = await service.ingestTrackBatch(
      {
        ...baseRequest,
        events: [trackEvent('a'), trackEvent('b'), trackEvent('c')],
      },
      transport(produce)
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') {
      return;
    }
    expect(outcome.accepted).toBe(2);
    expect(outcome.rejected).toHaveLength(1);
    expect(outcome.rejected[0]).toMatchObject({
      reason: 'internal',
      error: 'kafka unavailable',
    });
    expect(loggedErrors).toHaveLength(1);
  });

  it('keeps indices aligned across concurrency chunks', async () => {
    const { produce } = recordingProducer();
    const events: unknown[] = Array.from({ length: 120 }, (_, index) =>
      index % 37 === 0
        ? { type: 'track', payload: {} }
        : trackEvent(`e${index}`)
    );

    const outcome = await service.ingestTrackBatch(
      { ...baseRequest, events },
      transport(produce)
    );

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') {
      return;
    }
    expect(outcome.rejected.map((rejection) => rejection.index)).toEqual([
      0, 37, 74, 111,
    ]);
    expect(outcome.accepted).toBe(116);
    expect(produce).toHaveBeenCalledTimes(116);
  });

  it('refuses the whole batch without a project', async () => {
    const { produce } = recordingProducer();

    expect(
      await service.ingestTrackBatch(
        { ...baseRequest, projectId: null, events: [trackEvent('a')] },
        transport(produce)
      )
    ).toEqual({ status: 'missing-project-id' });
    expect(produce).not.toHaveBeenCalled();
  });
});

describe('historical floor', () => {
  const withAge = (ageMs: number) =>
    service.isOlderThanHistoricalFloor(
      ARRIVED_AT,
      service.getTimestamp(
        ARRIVED_AT,
        trackEvent('e', { __timestamp: atAge(ageMs) }).payload
      )
    );

  it('refuses events older than 5 days', () => {
    expect(withAge(5 * DAY_MS + 1000)).toBe(true);
  });

  it('accepts recent and up-to-5-day-old events', () => {
    expect(withAge(0)).toBe(false);
    expect(withAge(HOUR_MS)).toBe(false);
    expect(withAge(5 * DAY_MS - 1000)).toBe(false);
  });

  it('accepts an event without a client timestamp', () => {
    expect(
      service.isOlderThanHistoricalFloor(
        ARRIVED_AT,
        service.getTimestamp(ARRIVED_AT, trackEvent('e').payload)
      )
    ).toBe(false);
  });

  it('answers ingestTrack with timestamp-too-old and produces nothing', async () => {
    const { produce } = recordingProducer();

    expect(
      await service.ingestTrack(
        {
          ...baseRequest,
          body: trackEvent('old', { __timestamp: atAge(6 * DAY_MS) }),
        },
        transport(produce)
      )
    ).toEqual({ status: 'timestamp-too-old' });
    expect(produce).not.toHaveBeenCalled();
  });

  it('refuses a too-old legacy /event the same way', async () => {
    const { produce } = recordingProducer();

    expect(
      await service.ingestLegacyEvent(
        {
          ...baseRequest,
          body: {
            name: 'legacy',
            timestamp: atAge(0),
            properties: { __timestamp: atAge(6 * DAY_MS) },
          },
        },
        transport(produce)
      )
    ).toEqual({ status: 'timestamp-too-old' });
    expect(produce).not.toHaveBeenCalled();
  });
});

describe('historical events skip the live-session lookup', () => {
  it('a back-dated /track event gets the deterministic bucket id, never the live session', async () => {
    const { produced, produce } = recordingProducer();

    await service.ingestTrack(
      {
        ...baseRequest,
        body: trackEvent('offline', { __timestamp: atAge(2 * HOUR_MS) }),
      },
      transport(produce)
    );

    expect(getExistingSessions).not.toHaveBeenCalled();
    expect(produced[0]!.event.isTimestampFromThePast).toBe(true);
    expect(produced[0]!.sessionId).toBeTruthy();
  });

  it('a live /track event still reads the session buffer', async () => {
    const { produce } = recordingProducer();

    await service.ingestTrack(
      { ...baseRequest, body: trackEvent('live') },
      transport(produce)
    );

    expect(getExistingSessions).toHaveBeenCalledTimes(1);
  });

  it('a back-dated legacy /event skips the lookup and buckets by its own time', async () => {
    const { produced, produce } = recordingProducer();
    const send = (ageMs: number) =>
      service.ingestLegacyEvent(
        {
          ...baseRequest,
          body: {
            name: 'legacy',
            timestamp: atAge(0),
            properties: { __timestamp: atAge(ageMs) },
          },
        },
        transport(produce)
      );

    await send(2 * HOUR_MS);
    await send(2 * DAY_MS);

    expect(getExistingSessions).not.toHaveBeenCalled();
    expect(
      produced.map((payload) => payload.event.isTimestampFromThePast)
    ).toEqual([true, true]);
    expect(produced[0]!.sessionId).not.toBe(produced[1]!.sessionId);
  });
});

describe('isDuplicateIngestRequest', () => {
  it('never drops a batch envelope (SDKs retry whole batches)', async () => {
    expect(
      await service.isDuplicateIngestRequest({
        method: 'POST',
        clientIp: '1.2.3.4',
        headers: {
          origin: 'https://example.com',
          'openpanel-client-id': 'client-1',
        },
        body: { type: 'batch', payload: [trackEvent('a')] },
      })
    ).toBe(false);
  });
});
