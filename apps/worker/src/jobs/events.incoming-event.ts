import { getTime, isSameDomain, parsePath } from '@openpanel/common';
import { getReferrerWithQuery, parseReferrer } from '@openpanel/common/server';
import type { IServiceCreateEventPayload } from '@openpanel/db';
import {
  checkNotificationRulesForEvent,
  createEvent,
  getProjectByIdCached,
  matchEvent,
  SESSION_TIMEOUT_MS,
  sessionBuffer,
} from '@openpanel/db';
import type { ILogger } from '@openpanel/logger';
import type { EventsQueuePayloadIncomingEvent } from '@openpanel/queue';
import { getLock } from '@openpanel/redis';
import { anyPass, isEmpty, isNil, mergeDeepRight, omit, reject } from 'ramda';
import { sessionEndsEnqueued, sessionsStarted } from '@/metrics';
import { logger as baseLogger } from '@/utils/logger';
import { enqueueSessionEndV2 } from '@/utils/session-handler';

/**
 * Acquire a Redis-backed lock that prevents duplicate session_start rows for
 * the same `(projectId, sessionId)`. Returns true if THIS caller should emit
 * the session_start row; false if another worker (or earlier event in the
 * same batch) already claimed it.
 *
 * FORK: used only by the historical-reconstruction arm below (the live path
 * dedups inside `sessionBuffer.ingest`). TTL matches `SESSION_TIMEOUT_MS` —
 * the deterministic bucket is exactly that wide, so by the time the lock TTL
 * elapses the session itself has rolled to a new bucket.
 *
 * Keyed on sessionId (not deviceId) so historical events from the same device
 * but different buckets each get their own session_start.
 */
async function acquireSessionStartLock(
  projectId: string,
  sessionId: string,
): Promise<boolean> {
  if (!sessionId) {
    return false;
  }
  return getLock(
    `session_start:${projectId}:${sessionId}`,
    '1',
    SESSION_TIMEOUT_MS,
  );
}

const GLOBAL_PROPERTIES = ['__path', '__referrer', '__timestamp', '__revenue'];

// Strip empty/nullish from B, then deep-merge over A.
const merge = <A, B>(a: Partial<A>, b: Partial<B>): A & B =>
  mergeDeepRight(a, reject(anyPass([isEmpty, isNil]))(b)) as A & B;

async function isEventExcludedByProjectFilter(
  payload: IServiceCreateEventPayload,
  projectId: string
): Promise<boolean> {
  const project = await getProjectByIdCached(projectId);
  const eventExcludeFilters = (project?.filters ?? []).filter(
    (f) => f.type === 'event'
  );
  if (eventExcludeFilters.length === 0) {
    return false;
  }
  return eventExcludeFilters.some((filter) => matchEvent(payload, filter));
}

async function createEventAndNotify(
  payload: IServiceCreateEventPayload,
  logger: ILogger,
  projectId: string
) {
  const isExcluded = await isEventExcludedByProjectFilter(payload, projectId);
  if (isExcluded) {
    logger.info(
      { event: payload.name, projectId },
      'Event excluded by project filter'
    );
    return null;
  }

  logger.info({ event: payload }, 'Creating event');
  const [event] = await Promise.all([
    createEvent(payload),
    checkNotificationRulesForEvent(payload).catch(() => null),
  ]);
  return event;
}

const parseRevenue = (revenue: unknown): number | undefined => {
  if (!revenue) {
    return undefined;
  }
  if (typeof revenue === 'number') {
    return revenue;
  }
  if (typeof revenue === 'string') {
    const parsed = Number.parseFloat(revenue);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

export async function incomingEvent(
  jobPayload: EventsQueuePayloadIncomingEvent['payload'],
  // Kafka delivery coordinates, when the event came through the Kafka consumer.
  // Logged so a duplicate row in ClickHouse can be traced back to the exact
  // partition/offset that produced it.
  meta?: { partition: number; offset: string }
) {
  const {
    geo,
    event: body,
    headers,
    projectId,
    deviceId,
    sessionId,
    uaInfo,
  } = jobPayload;
  const properties = body.properties ?? {};
  const reqId = headers['request-id'] ?? 'unknown';
  const logger = baseLogger.child({
    reqId,
    ...(meta
      ? { kafkaPartition: meta.partition, kafkaOffset: meta.offset }
      : {}),
  });
  const getProperty = (name: string): string | undefined => {
    // replace thing is just for older sdks when we didn't have `__`
    // remove when kiddokitchen app (24.09.02) is not used anymore
    return (
      ((properties[name] || properties[name.replace('__', '')]) as
        | string
        | null
        | undefined) ?? undefined
    );
  };

  const profileId = body.profileId ? String(body.profileId) : '';
  const createdAt = new Date(body.timestamp);
  // Historical = older than the API's 15-min cutoff (offline/late uploads).
  // These don't extend or open a live session; the non-server reconstruction
  // arm below rebuilds a session from the deterministic id instead.
  const isTimestampFromThePast = body.isTimestampFromThePast;
  const url = getProperty('__path');
  const { path, hash, query, origin } = parsePath(url);
  const referrer = isSameDomain(getProperty('__referrer'), url)
    ? null
    : parseReferrer(getProperty('__referrer'));
  const utmReferrer = getReferrerWithQuery(query);
  const sdkName = headers['openpanel-sdk-name'];
  const sdkVersion = headers['openpanel-sdk-version'];

  const baseEvent: IServiceCreateEventPayload = {
    name: body.name,
    profileId,
    projectId,
    deviceId,
    sessionId,
    properties: omit(GLOBAL_PROPERTIES, {
      ...properties,
      __hash: hash,
      __query: query,
      __syncedAt: new Date().toISOString(),
    }),
    groups: body.groups ?? [],
    createdAt,
    duration: 0,
    sdkName,
    sdkVersion,
    city: geo.city,
    country: geo.country,
    region: geo.region,
    longitude: geo.longitude,
    latitude: geo.latitude,
    path,
    origin,
    referrer: referrer?.url || '',
    referrerName: utmReferrer?.name || referrer?.name || referrer?.url,
    referrerType: utmReferrer?.type || referrer?.type || '',
    os: uaInfo.os,
    osVersion: uaInfo.osVersion,
    browser: uaInfo.browser,
    browserVersion: uaInfo.browserVersion,
    device: uaInfo.device,
    brand: uaInfo.brand,
    model: uaInfo.model,
    revenue:
      body.name === 'revenue' && '__revenue' in properties
        ? parseRevenue(properties.__revenue)
        : undefined,
  };

  // Server-side events: when a profileId is supplied (and the event isn't
  // historical), enrich from the user's most recent browser session (deviceId,
  // sessionId, geo, UA, path, referrer). Without a session, fall back to the
  // API-computed identity. Server events never create or extend live sessions.
  // Past server events are NOT enriched — they keep the deterministic id the
  // edge minted, matching the live-session idle semantics.
  if (uaInfo.isServer) {
    const enrichment =
      profileId && !isTimestampFromThePast
        ? await sessionBuffer.getExistingSession({ profileId, projectId })
        : null;

    const payload: IServiceCreateEventPayload = enrichment
      ? {
          ...baseEvent,
          deviceId: enrichment.device_id,
          sessionId: enrichment.id,
          referrer: enrichment.referrer ?? baseEvent.referrer,
          referrerName: enrichment.referrer_name ?? baseEvent.referrerName,
          referrerType: enrichment.referrer_type ?? baseEvent.referrerType,
          path: enrichment.exit_path ?? baseEvent.path,
          origin: enrichment.exit_origin ?? baseEvent.origin,
          os: enrichment.os ?? baseEvent.os,
          osVersion: enrichment.os_version ?? baseEvent.osVersion,
          browserVersion:
            enrichment.browser_version ?? baseEvent.browserVersion,
          browser: enrichment.browser ?? baseEvent.browser,
          device: enrichment.device ?? baseEvent.device,
          brand: enrichment.brand ?? baseEvent.brand,
          model: enrichment.model ?? baseEvent.model,
          city: enrichment.city ?? baseEvent.city,
          country: enrichment.country ?? baseEvent.country,
          region: enrichment.region ?? baseEvent.region,
          longitude: enrichment.longitude ?? baseEvent.longitude,
          latitude: enrichment.latitude ?? baseEvent.latitude,
        }
      : baseEvent;

    return createEventAndNotify(payload, logger, projectId);
  }

  if (await isEventExcludedByProjectFilter(baseEvent, projectId)) {
    logger.info(
      { event: baseEvent.name, projectId },
      'Skipping session_start and event (excluded by project filter)'
    );
    return null;
  }

  // FORK: non-server historical / late-uploaded events (offline-first SDKs).
  // The API has already minted a deterministic, timestamp-bucketed sessionId
  // for them (it skipped the live-session lookup — see ids.ts). Reconstruct the
  // session: emit one session_start per (project, sessionId) bucket, deduped by
  // a Redis lock so parallel batch events / workers don't double-insert. Do NOT
  // touch live session state (no sessionBuffer.ingest, no sessionEnd) — a
  // backfill must not extend or close the user's current session.
  if (isTimestampFromThePast) {
    if (await acquireSessionStartLock(projectId, sessionId)) {
      await createEventAndNotify(
        {
          ...baseEvent,
          name: 'session_start',
          createdAt: new Date(getTime(baseEvent.createdAt) - 100),
        },
        logger,
        projectId,
      ).catch((error) => {
        logger.error(
          { err: error, event: baseEvent },
          'Error creating historical session start event',
        );
        // Best-effort — the event itself should still land.
      });
    }
    return createEventAndNotify(baseEvent, logger, projectId);
  }

  // Live path. `sessionBuffer.ingest` is the single source of truth for session
  // lifecycle: reads the current session, decides extend/new/boundary, writes
  // back. The returned `current` is the canonical session — use its referrer
  // fields for inheritance.
  const session = await sessionBuffer.ingest(baseEvent);

  if (session?.kind === 'boundary') {
    // Close the old session in a separate job (one Redis-buffered insert for
    // the session_end event + notification rule check). Idempotent via BullMQ
    // jobId dedup.
    await enqueueSessionEndV2({
      payload: baseEvent,
      closedSession: session.closed,
    })
      .then(() => sessionEndsEnqueued.inc({ source: 'boundary' }))
      .catch((error) => {
        logger.error(
          { err: error, deviceId, sessionId: session.closed.id },
          'Error enqueueing session_end on boundary'
        );
      });
  }

  if (session?.kind === 'new' || session?.kind === 'boundary') {
    sessionsStarted.inc({ kind: session.kind });
    await createEventAndNotify(
      {
        ...baseEvent,
        name: 'session_start',
        createdAt: new Date(getTime(baseEvent.createdAt) - 100),
      },
      logger,
      projectId
    ).catch((error) => {
      logger.error(
        { err: error, event: baseEvent },
        'Error creating session start event'
      );
      throw error;
    });
  }

  // Inherit referrer fields from the canonical session for the actual event.
  // For 'extend' this preserves the original session's referrer across
  // mid-session events; for 'new' / 'boundary' it's the event's own referrer
  // (which `ingest` just stored on the fresh session).
  const finalPayload: IServiceCreateEventPayload = session
    ? merge(baseEvent, {
        referrer: session.current.referrer,
        referrerName: session.current.referrer_name,
        referrerType: session.current.referrer_type,
      } as Partial<IServiceCreateEventPayload>)
    : baseEvent;

  return createEventAndNotify(finalPayload, logger, projectId);
}
