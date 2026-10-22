// FORK (ToHands): the session_start dedup lock for historical uploads.

import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

const getLock = mock(
  async (_key: string, _value: string, _ttlMs: number) => true
);
const del = mock(async (_key: string) => 1);

let createHistoricalSessionStartLock: typeof import('./historical-session').createHistoricalSessionStartLock;
beforeAll(async () => {
  const realRedis = await import('@openpanel/redis');
  mock.module('@openpanel/redis', () => ({
    ...realRedis,
    getLock,
    getRedisCache: () => ({ del }),
  }));
  ({ createHistoricalSessionStartLock } = await import('./historical-session'));
});

beforeEach(() => {
  getLock.mockClear();
  del.mockClear();
});

describe('createHistoricalSessionStartLock', () => {
  it('claims one key per (project, session) for the session timeout', async () => {
    const lock = createHistoricalSessionStartLock(SESSION_TIMEOUT_MS);

    expect(await lock.claim('proj', 'sess-1')).toBe(true);
    expect(getLock).toHaveBeenCalledWith(
      'session_start:proj:sess-1',
      '1',
      SESSION_TIMEOUT_MS
    );
  });

  it('reports an already-held bucket as not claimed', async () => {
    getLock.mockImplementationOnce(async () => false);
    const lock = createHistoricalSessionStartLock(SESSION_TIMEOUT_MS);

    expect(await lock.claim('proj', 'sess-1')).toBe(false);
  });

  it('never claims for an event without a session id', async () => {
    const lock = createHistoricalSessionStartLock(SESSION_TIMEOUT_MS);

    expect(await lock.claim('proj', '')).toBe(false);
    expect(getLock).not.toHaveBeenCalled();
  });

  it('release deletes the same key so a redelivery can claim again', async () => {
    const lock = createHistoricalSessionStartLock(SESSION_TIMEOUT_MS);

    await lock.release('proj', 'sess-1');
    expect(del).toHaveBeenCalledWith('session_start:proj:sess-1');
  });
});
