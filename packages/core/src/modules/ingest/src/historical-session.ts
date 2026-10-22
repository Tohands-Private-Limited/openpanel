// FORK (ToHands): offline-first SDKs upload genuinely past sessions, so a
// historical event (older than the API's 15-min `isTimestampFromThePast`
// cutoff) reconstructs its own session instead of riding a live one. The API
// minted a deterministic, timestamp-bucketed session id for it (device-id.ts
// skips the live lookup); this lock makes exactly one event per
// `(project, session)` emit the `session_start`. See FORK-PATCHES.md.

import { getLock, getRedisCache } from '@openpanel/redis';

const LOCK_KEY_PREFIX = 'session_start:';

export interface HistoricalSessionStartLock {
  /** True when this caller should emit the bucket's session_start. */
  claim(projectId: string, sessionId: string): Promise<boolean>;
  /** Undo a claim whose session_start was never written, so a redelivery can retry it. */
  release(projectId: string, sessionId: string): Promise<void>;
}

const lockKey = (projectId: string, sessionId: string) =>
  `${LOCK_KEY_PREFIX}${projectId}:${sessionId}`;

/** The TTL tracks the bucket width: the deterministic id rolls over with it. */
export function createHistoricalSessionStartLock(
  ttlMs: number
): HistoricalSessionStartLock {
  return {
    claim: async (projectId, sessionId) => {
      if (!sessionId) {
        return false;
      }
      return await getLock(lockKey(projectId, sessionId), '1', ttlMs);
    },
    release: async (projectId, sessionId) => {
      await getRedisCache().del(lockKey(projectId, sessionId));
    },
  };
}
