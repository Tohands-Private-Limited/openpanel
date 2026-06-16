import {
  createEvent,
  formatClickhouseDate,
  type IClickhouseSession,
  sessionBuffer,
} from '@openpanel/db';
import {
  type EventsQueuePayloadIncomingEvent,
  sessionsQueue,
} from '@openpanel/queue';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { incomingEvent } from './events.incoming-event';

vi.mock('@openpanel/queue');
vi.mock('@openpanel/db', async () => {
  const actual = await vi.importActual('@openpanel/db');
  return {
    ...actual,
    createEvent: vi.fn(),
    checkNotificationRulesForEvent: vi.fn().mockResolvedValue(true),
    getProjectByIdCached: vi.fn().mockResolvedValue({ filters: [] }),
    matchEvent: vi.fn().mockReturnValue(false),
    sessionBuffer: {
      // name/getBufferSize keep metrics.ts happy (it registers a per-buffer
      // gauge at import); the tests only drive getExistingSession/ingest.
      name: 'session',
      getBufferSize: vi.fn().mockResolvedValue(0),
      getExistingSession: vi.fn(),
      ingest: vi.fn(),
    },
  };
});
// Mock the session_start dedup lock so tests don't need a live Redis. By
// default the lock is acquired (true) so existing tests' session_start
// expectations still hold; individual tests can override per-call.
vi.mock('@openpanel/redis', async () => {
  const actual = await vi.importActual('@openpanel/redis');
  return {
    ...actual,
    getLock: vi.fn().mockResolvedValue(true),
  };
});

const projectId = 'test-project';
const deviceId = 'device-123';
const newSessionId = 'a1b2c3d4-e5f6-4789-a012-345678901234';
const geo = {
  country: 'US',
  city: 'New York',
  region: 'NY',
  longitude: 0,
  latitude: 0,
};

const uaInfo: EventsQueuePayloadIncomingEvent['payload']['uaInfo'] = {
  isServer: false,
  device: 'desktop',
  os: 'Windows',
  osVersion: '10',
  browser: 'Chrome',
  browserVersion: '91.0.4472.124',
  brand: '',
  model: '',
};

const uaInfoServer: EventsQueuePayloadIncomingEvent['payload']['uaInfo'] = {
  isServer: true,
  device: 'server',
  os: '',
  osVersion: '',
  browser: '',
  browserVersion: '',
  brand: '',
  model: '',
};

function makeSession(
  overrides: Partial<IClickhouseSession> = {}
): IClickhouseSession {
  const now = new Date();
  return {
    id: 'session-existing',
    project_id: projectId,
    device_id: deviceId,
    profile_id: '',
    event_count: 1,
    screen_view_count: 0,
    entry_path: '/',
    entry_origin: 'https://example.com',
    exit_path: '/',
    exit_origin: 'https://example.com',
    created_at: formatClickhouseDate(now),
    ended_at: formatClickhouseDate(now),
    os: 'Windows',
    os_version: '10',
    browser: 'Chrome',
    browser_version: '91.0.4472.124',
    device: 'desktop',
    brand: '',
    model: '',
    country: 'US',
    region: 'NY',
    city: 'New York',
    longitude: 0,
    latitude: 0,
    duration: 0,
    referrer: '',
    referrer_name: '',
    referrer_type: '',
    is_bounce: true,
    utm_term: '',
    utm_source: '',
    utm_campaign: '',
    utm_content: '',
    utm_medium: '',
    revenue: 0,
    sign: 1,
    version: 1,
    groups: [],
    ...overrides,
  } satisfies IClickhouseSession;
}

function buildJobData(
  overrides: Partial<EventsQueuePayloadIncomingEvent['payload']> = {}
): EventsQueuePayloadIncomingEvent['payload'] {
  return {
    geo,
    event: {
      name: 'test_event',
      timestamp: new Date().toISOString(),
      isTimestampFromThePast: false,
      properties: { __path: 'https://example.com/test' },
    },
    uaInfo,
    headers: {
      'request-id': '123',
      'user-agent': 'Mozilla/5.0',
      'openpanel-sdk-name': 'web',
      'openpanel-sdk-version': '1.0.0',
    },
    projectId,
    deviceId,
    sessionId: newSessionId,
    ...overrides,
  };
}

describe('incomingEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createEvent as Mock).mockImplementation((event) => event);
  });

  // ----- Live path (sessionBuffer.ingest) -----

  it('emits session_start when ingest returns kind="new"', async () => {
    vi.mocked(sessionBuffer.ingest).mockResolvedValueOnce({
      kind: 'new',
      current: makeSession({ id: newSessionId }),
    });

    await incomingEvent(buildJobData());

    expect(sessionsQueue.add).not.toHaveBeenCalled();
    const calls = (createEvent as Mock).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].name).toBe('session_start');
    expect(calls[1]![0].name).toBe('test_event');
    // FORK: every written event carries a __syncedAt processing stamp.
    expect(calls[1]![0].properties.__syncedAt).toEqual(expect.any(String));
  });

  it('skips session_start when ingest returns kind="extend"', async () => {
    vi.mocked(sessionBuffer.ingest).mockResolvedValueOnce({
      kind: 'extend',
      current: makeSession(),
    });

    await incomingEvent(buildJobData());

    expect(sessionsQueue.add).not.toHaveBeenCalled();
    const sessionStartCalls = (createEvent as Mock).mock.calls.filter(
      ([arg]) => arg?.name === 'session_start'
    );
    expect(sessionStartCalls).toHaveLength(0);
  });

  it('closes old session and emits session_start when ingest returns kind="boundary"', async () => {
    const closed = makeSession({ id: 'old-session-id' });
    const current = makeSession({ id: newSessionId });
    vi.mocked(sessionBuffer.ingest).mockResolvedValueOnce({
      kind: 'boundary',
      current,
      closed,
    });

    const spy = vi.spyOn(sessionsQueue, 'add').mockResolvedValue({} as Job);

    await incomingEvent(buildJobData());

    expect(spy).toHaveBeenCalledTimes(1);
    const [, payload, opts] = spy.mock.calls[0]!;
    expect((payload as any).type).toBe('createSessionEnd');
    expect((payload as any).payload.sessionId).toBe('old-session-id');
    expect((payload as any).snapshot.id).toBe('old-session-id');
    expect(opts?.jobId).toBe('sessionEnd:v2:old-session-id');

    const calls = (createEvent as Mock).mock.calls;
    expect(calls.filter(([a]) => a?.name === 'session_start')).toHaveLength(1);
    expect(calls.filter(([a]) => a?.name === 'test_event')).toHaveLength(1);
  });

  it('inherits referrer from current session on the actual event', async () => {
    vi.mocked(sessionBuffer.ingest).mockResolvedValueOnce({
      kind: 'extend',
      current: makeSession({
        referrer: 'https://google.com',
        referrer_name: 'Google',
        referrer_type: 'search',
      }),
    });

    await incomingEvent(buildJobData());

    const testEventCall = (createEvent as Mock).mock.calls.find(
      ([a]) => a?.name === 'test_event'
    );
    expect(testEventCall![0].referrer).toBe('https://google.com');
    expect(testEventCall![0].referrerName).toBe('Google');
    expect(testEventCall![0].referrerType).toBe('search');
  });

  it('emits session_start only once across 3 rapid events (new → extend → extend)', async () => {
    const session = makeSession({ id: newSessionId });
    vi.mocked(sessionBuffer.ingest)
      .mockResolvedValueOnce({ kind: 'new', current: session })
      .mockResolvedValueOnce({ kind: 'extend', current: session })
      .mockResolvedValueOnce({ kind: 'extend', current: session });

    await incomingEvent(buildJobData({ event: { name: 'e1', timestamp: new Date().toISOString(), isTimestampFromThePast: false, properties: { __path: 'https://example.com/test' } } }));
    await incomingEvent(buildJobData({ event: { name: 'e2', timestamp: new Date().toISOString(), isTimestampFromThePast: false, properties: { __path: 'https://example.com/test' } } }));
    await incomingEvent(buildJobData({ event: { name: 'e3', timestamp: new Date().toISOString(), isTimestampFromThePast: false, properties: { __path: 'https://example.com/test' } } }));

    const sessionStartCalls = (createEvent as Mock).mock.calls.filter(
      ([a]) => a?.name === 'session_start'
    );
    expect(sessionStartCalls).toHaveLength(1);
    expect(sessionsQueue.add).not.toHaveBeenCalled();
  });

  // ----- Server events (ride existing session, never open/close) -----

  it('handles server events with existing profile session', async () => {
    const jobData = buildJobData({
      event: {
        name: 'server_event',
        timestamp: new Date().toISOString(),
        isTimestampFromThePast: false,
        properties: { custom_property: 'test_value' },
        profileId: 'profile-123',
      },
      uaInfo: uaInfoServer,
      deviceId: '',
      sessionId: '',
      headers: {
        'user-agent': 'OpenPanel Server/1.0',
        'openpanel-sdk-name': 'server',
        'openpanel-sdk-version': '1.0.0',
        'request-id': '123',
      },
    });

    vi.mocked(sessionBuffer.getExistingSession).mockResolvedValueOnce(
      makeSession({
        id: 'last-session-456',
        device_id: 'last-device-123',
        profile_id: 'profile-123',
        country: 'CA',
        region: 'ON',
        city: 'Toronto',
        referrer: 'https://google.com',
        referrer_name: 'Google',
        referrer_type: 'search',
      })
    );

    await incomingEvent(jobData);

    expect(sessionBuffer.ingest).not.toHaveBeenCalled();
    expect(sessionsQueue.add).not.toHaveBeenCalled();
    expect((createEvent as Mock).mock.calls[0]![0]).toMatchObject({
      name: 'server_event',
      deviceId: 'last-device-123',
      sessionId: 'last-session-456',
      profileId: 'profile-123',
      city: 'Toronto',
      country: 'CA',
      referrer: 'https://google.com',
    });
  });

  it('handles server events without any active session', async () => {
    vi.mocked(sessionBuffer.getExistingSession).mockResolvedValueOnce(null);

    await incomingEvent(
      buildJobData({
        event: {
          name: 'server_event',
          timestamp: new Date().toISOString(),
          properties: { custom_property: 'test_value' },
          profileId: 'profile-123',
          isTimestampFromThePast: false,
        },
        uaInfo: uaInfoServer,
        deviceId: '',
        sessionId: '',
        headers: {
          'user-agent': 'OpenPanel Server/1.0',
          'openpanel-sdk-name': 'server',
          'openpanel-sdk-version': '1.0.0',
          'request-id': '123',
        },
      })
    );

    expect(sessionBuffer.ingest).not.toHaveBeenCalled();
    expect(sessionsQueue.add).not.toHaveBeenCalled();
    expect((createEvent as Mock).mock.calls[0]![0]).toMatchObject({
      name: 'server_event',
      // Server event with profileId but no existing session: keep the
      // API-computed identity instead of blanking deviceId/sessionId.
      // The fixture sends '' for both so that's what we expect here.
      deviceId: '',
      sessionId: '',
      profileId: 'profile-123',
    });
  });

  it('does NOT enrich a server event when the timestamp is from the past', async () => {
    // Past server event: enrichment is skipped (profileId && !isTimestampFromThePast
    // is false), so getExistingSession is never read and the API-computed id stays.
    await incomingEvent(
      buildJobData({
        event: {
          name: 'server_event',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          isTimestampFromThePast: true,
          properties: { custom_property: 'test_value' },
          profileId: 'profile-123',
        },
        uaInfo: uaInfoServer,
        deviceId: 'server-device',
        sessionId: 'server-bucket-id',
      })
    );

    expect(sessionBuffer.getExistingSession).not.toHaveBeenCalled();
    expect(sessionBuffer.ingest).not.toHaveBeenCalled();
    expect(sessionsQueue.add).not.toHaveBeenCalled();
    const calls = (createEvent as Mock).mock.calls;
    // No session_start for server events, just the event itself.
    expect(calls.filter(([a]) => a?.name === 'session_start')).toHaveLength(0);
    expect(calls[0]![0]).toMatchObject({
      name: 'server_event',
      deviceId: 'server-device',
      sessionId: 'server-bucket-id',
    });
  });

  // ----- FORK: historical reconstruction arm (isTimestampFromThePast) -----

  it('reconstructs a historical session: session_start + event, no live state touched', async () => {
    await incomingEvent(
      buildJobData({
        event: {
          name: 'historical_event',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          isTimestampFromThePast: true,
          properties: { __path: 'https://example.com/replay' },
        },
        deviceId: 'mobile-device-xyz',
        sessionId: 'deterministic-bucket-id',
      })
    );

    // Live state untouched: ingest never runs, no sessionEnd job scheduled.
    expect(sessionBuffer.ingest).not.toHaveBeenCalled();
    expect(sessionsQueue.add).not.toHaveBeenCalled();

    // Two createEvent calls: the historical session_start (lock acquired by
    // default in the redis mock) and the event itself, both keeping the
    // API-computed deterministic id.
    const calls = (createEvent as Mock).mock.calls;
    expect(calls).toHaveLength(2);
    const startCall = calls.find(([a]) => a?.name === 'session_start');
    const eventCall = calls.find(([a]) => a?.name === 'historical_event');
    expect(startCall).toBeDefined();
    expect(eventCall).toBeDefined();
    expect(eventCall![0].deviceId).toBe('mobile-device-xyz');
    expect(eventCall![0].sessionId).toBe('deterministic-bucket-id');
  });

  it('historical event does not duplicate session_start when the lock is held', async () => {
    const { getLock } = await import('@openpanel/redis');
    // Another worker / earlier batch event already claimed the session_start.
    vi.mocked(getLock).mockResolvedValueOnce(false);

    await incomingEvent(
      buildJobData({
        event: {
          name: 'historical_event',
          timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
          isTimestampFromThePast: true,
          properties: { __path: 'https://example.com/replay' },
        },
        deviceId: 'mobile-device-xyz',
        sessionId: 'deterministic-bucket-id',
      })
    );

    expect(sessionBuffer.ingest).not.toHaveBeenCalled();
    expect(sessionsQueue.add).not.toHaveBeenCalled();
    const calls = (createEvent as Mock).mock.calls;
    // No session_start (lock not acquired), but the event itself still lands.
    expect(calls.filter(([a]) => a?.name === 'session_start')).toHaveLength(0);
    expect(calls.filter(([a]) => a?.name === 'historical_event')).toHaveLength(
      1
    );
  });
});
