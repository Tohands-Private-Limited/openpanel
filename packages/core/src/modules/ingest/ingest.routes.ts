// THE HOOK ORDER IS THE CONTRACT: duplicate -> clientAuth -> isBot ->
// subscription. It holds by lifecycle phase rather than registration order
// (verified against Elysia 1.4.30: `derive -> transform -> macro resolve ->
// beforeHandle`). So the duplicate check is a `transform`, `clientAuth` is the
// macro, and the bot check is a `beforeHandle`, which lets it read
// `client.secretVerified` after the macro resolves the principal.
//
// `POST /event`, a legacy route production still posts to, has the same hook
// chain plus a per-client usage counter recorded after authentication (so a
// label is always a real client id) and before the hooks that can
// short-circuit (so a client whose events are dropped still counts).

import type { AppDeps, HttpCtx } from '../../context';
import { defineRoutes } from '../../http/define';
import { toIngestHeaders } from '../../shared/headers';
import type { DeprecatedPostEventPayload } from './ingest.constants';
import {
  TRACK_BATCH_MAX_BODY_BYTES,
  TRACK_BATCH_MAX_EVENTS,
  zTrackBatchBody,
  zTrackRequestBody,
} from './ingest.constants';
import {
  checkIngestBot,
  fetchDeviceIdentity,
  ingestLegacyEvent,
  ingestTrack,
  ingestTrackBatch,
  isDuplicateIngestRequest,
  isIngestionWoundDown,
  TRACK_REJECTION_MESSAGES,
  type TrackBatchOutcome,
  type TrackOutcome,
} from './ingest.service';
import { validateIngestRequest } from './src/client-auth';
import { recordLegacyEventRequest } from './src/ingest.metrics';
import { produceIncomingEvent } from './src/kafka';

const TAGS = ['Track'];
const LEGACY_EVENT_TAGS = ['Event'];
const DUPLICATE_BODY = 'Duplicate event';
/** Wind-down answers 202 with `{blocked:true}` rather than 402/403 — see
 *  `isIngestionWoundDown`. */
const WIND_DOWN_STATUS = 202;
const ACCEPTED_STATUS = 202;

type StatusFn = (code: number, body?: unknown) => unknown;

const PAYLOAD_TOO_LARGE = 413;

/**
 * kafkajs answers a body over the broker's `max.message.bytes` with a raw
 * protocol error, which surfaced as a 500 carrying "The request included a
 * message larger than the max message size the server will accept". The
 * threshold is the broker's, so it is configuration rather than a constant —
 * a deployment that raises `max.message.bytes` raises this with it.
 */
function refuseOversizedBody({
  body,
  ctx,
  request,
  status,
}: {
  body?: unknown;
  ctx: { config: { kafka: { maxMessageBytes: number } } };
  request: Request;
  status: StatusFn;
}) {
  const declared = Number(request.headers.get('content-length'));
  // FORK: a batch becomes one Kafka message per event, so the envelope gets
  // its own cap and each item is held to the broker limit in the service.
  const limit = isBatchEnvelope(body)
    ? Math.max(TRACK_BATCH_MAX_BODY_BYTES, ctx.config.kafka.maxMessageBytes)
    : ctx.config.kafka.maxMessageBytes;
  if (!Number.isFinite(declared) || declared <= limit) {
    return;
  }
  return status(PAYLOAD_TOO_LARGE, {
    status: PAYLOAD_TOO_LARGE,
    error: 'Payload Too Large',
    message: `Body is ${declared} bytes; the limit is ${limit}.`,
  });
}

function isBatchEnvelope(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { type?: unknown }).type === 'batch'
  );
}

/** FORK: the batch response is a client contract (Flutter / LVGL SDKs). */
function respondToBatchOutcome(outcome: TrackBatchOutcome, status: StatusFn) {
  if (outcome.status === 'missing-project-id') {
    return status(400, { status: 400, message: 'Missing projectId' });
  }
  return status(ACCEPTED_STATUS, {
    accepted: outcome.accepted,
    rejected: outcome.rejected,
  });
}

const BATCH_DESCRIPTION = `Batches accept up to ${TRACK_BATCH_MAX_EVENTS} events and ${TRACK_BATCH_MAX_BODY_BYTES / (1024 * 1024)}MB uncompressed per request. Each event runs through the same pipeline as a single-event request; per-event failures are returned in rejected[] (202) instead of failing the batch.`;

// There is no thrown-HttpError handler here, so the outcome-to-response
// mapping is explicit.
function respondToOutcome(outcome: TrackOutcome, status: StatusFn) {
  switch (outcome.status) {
    case 'ok':
      return { deviceId: outcome.deviceId, sessionId: outcome.sessionId };
    case 'alias-not-supported':
      return status(400, {
        status: 400,
        error: 'Bad Request',
        message: 'Alias is not supported',
      });
    case 'invalid-type':
      return status(400, {
        status: 400,
        error: 'Bad Request',
        message: 'Invalid type',
      });
    case 'missing-project-id':
      return status(400, { status: 400, message: 'Missing projectId' });
    case 'replay-missing-session-id':
      return status(400, {
        status: 400,
        message: 'Session ID is required for replay',
      });
    case 'profile-not-found':
      return status(404, { status: 404, message: 'Profile not found' });
    case 'profile-property-not-a-number':
      return status(400, {
        status: 400,
        message: 'Property value is not a number',
      });
    case 'timestamp-too-old':
      return status(400, {
        status: 400,
        error: 'Bad Request',
        message: TRACK_REJECTION_MESSAGES['timestamp-too-old'],
      });
    default: {
      // `outcome` narrows to `never`: an eighth TrackOutcome variant fails the
      // compile here instead of silently getting the 400 above.
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

// A route-level `beforeHandle`, which runs after the macro resolved the
// principal, so it can read `client.secretVerified`.
async function botGuard({
  body,
  client,
  ctx,
  status,
}: {
  body: unknown;
  client: { projectId: string | null; secretVerified: boolean };
  ctx: HttpCtx;
  status: StatusFn;
}) {
  const bot = await checkIngestBot(ctx, {
    headers: toIngestHeaders(ctx.headers),
    clientSecretAuth: client.secretVerified,
    projectId: client.projectId,
    body,
  });
  if (bot) {
    return status(202, { bot });
  }
}

/** The wind-down gate: the last `beforeHandle` on both ingest routers. */
function windDownGuard(deps: AppDeps) {
  return async ({
    client,
    ctx,
    status,
  }: {
    client: { projectId: string | null };
    ctx: HttpCtx;
    status: StatusFn;
  }) => {
    const blocked = await isIngestionWoundDown(ctx, {
      projectId: client.projectId,
      selfHosted: deps.config.selfHosted,
      logger: ctx.logger,
    });
    if (blocked) {
      return status(WIND_DOWN_STATUS, { blocked: true });
    }
  };
}

export const ingestRoutes = defineRoutes((app, deps: AppDeps) => {
  const blockWhenWoundDown = windDownGuard(deps);

  return app.guard(
    {
      // Answers before the client is ever authenticated. A guard hook runs
      // ahead of the `clientAuth` macro's resolve and is scoped to the two
      // routes below: derive -> guard beforeHandle -> macro resolve -> route
      // beforeHandle.
      async beforeHandle({ body, ctx, request, status }) {
        if (
          await isDuplicateIngestRequest({
            method: request.method,
            clientIp: ctx.ip,
            headers: toIngestHeaders(ctx.headers),
            body,
          })
        ) {
          return status(200, DUPLICATE_BODY);
        }
      },
    },
    (routes) =>
      routes
        .post(
          '/track',
          async ({ body, client, ctx, status, timestamp }) => {
            const request = {
              projectId: client.projectId,
              clientIp: ctx.ip,
              headers: toIngestHeaders(ctx.headers),
              clientSecretAuth: client.secretVerified,
              timestamp,
            };
            const transport = {
              buffers: ctx.buffers,
              produceIncomingEvent: (payload, partitionKey) =>
                produceIncomingEvent(ctx.config, payload, partitionKey),
              deps: ctx,
            } satisfies Parameters<typeof ingestTrack>[1];

            if (body.type === 'batch') {
              const batch = await ingestTrackBatch(
                { ...request, events: body.payload },
                transport
              );
              return respondToBatchOutcome(batch, status);
            }

            const outcome = await ingestTrack({ ...request, body }, transport);

            return respondToOutcome(outcome, status);
          },
          {
            clientAuth: { ingest: validateIngestRequest },
            body: zTrackRequestBody,
            beforeHandle: [refuseOversizedBody, botGuard, blockWhenWoundDown],
            detail: {
              tags: TAGS,
              description: `Ingest a tracking event (track, identify, group, increment, decrement, replay) or a batch of them ({ "type": "batch", "payload": [event, ...] }). ${BATCH_DESCRIPTION}`,
            },
          }
        )
        // FORK: deprecated alias for clients shipped before the /track batch
        // envelope existed. Remove once production logs show no more calls.
        .post(
          '/track/batch',
          async ({ body, client, ctx, status, timestamp }) => {
            ctx.logger.warn(
              {
                deprecatedEndpoint: 'POST /track/batch',
                projectId: client.projectId,
                clientId: client.id,
                eventCount: body.events.length,
              },
              'deprecated /track/batch used — migrate to POST /track with { type: "batch", payload: [...] }'
            );
            const batch = await ingestTrackBatch(
              {
                projectId: client.projectId,
                clientIp: ctx.ip,
                headers: toIngestHeaders(ctx.headers),
                clientSecretAuth: client.secretVerified,
                timestamp,
                events: body.events,
              },
              {
                buffers: ctx.buffers,
                produceIncomingEvent: (payload, partitionKey) =>
                  produceIncomingEvent(ctx.config, payload, partitionKey),
                deps: ctx,
              }
            );
            return respondToBatchOutcome(batch, status);
          },
          {
            clientAuth: { ingest: validateIngestRequest },
            body: zTrackBatchBody,
            beforeHandle: [
              ({ ctx, request, status }) =>
                refuseOversizedBody({
                  body: { type: 'batch' },
                  ctx,
                  request,
                  status,
                }),
              botGuard,
              blockWhenWoundDown,
            ],
            detail: {
              tags: TAGS,
              deprecated: true,
              description: `Deprecated — use POST /track with { "type": "batch", "payload": [event, ...] }. ${BATCH_DESCRIPTION}`,
            },
          }
        )
        .get(
          '/track/device-id',
          async ({ client, ctx, status }) => {
            const identity = await fetchDeviceIdentity(
              ctx,
              {
                projectId: client.projectId,
                clientIp: ctx.ip,
                headers: toIngestHeaders(ctx.headers),
              },
              ctx.buffers,
              ctx.logger
            );

            switch (identity.status) {
              case 'missing-project-id':
                return status(400, 'No projectId');
              case 'missing-ip':
                return status(400, 'Missing ip address');
              case 'missing-user-agent':
                return status(400, 'Missing header: user-agent');
              default:
                return {
                  deviceId: identity.deviceId,
                  sessionId: identity.sessionId,
                  message: identity.message,
                };
            }
          },
          {
            clientAuth: { ingest: validateIngestRequest },
            beforeHandle: [botGuard, blockWhenWoundDown],
            detail: {
              tags: TAGS,
              description:
                'Get or generate a stable device ID and session ID for the current visitor.',
            },
          }
        )
        .post(
          '/event',
          async ({ body, client, ctx, status, timestamp }) => {
            const outcome = await ingestLegacyEvent(
              {
                projectId: client.projectId,
                clientIp: ctx.ip,
                headers: toIngestHeaders(ctx.headers),
                clientSecretAuth: client.secretVerified,
                timestamp,
                body: body as DeprecatedPostEventPayload | null,
              },
              {
                buffers: ctx.buffers,
                produceIncomingEvent: (payload, partitionKey) =>
                  produceIncomingEvent(ctx.config, payload, partitionKey),
                deps: ctx,
              }
            );

            if (outcome.status === 'missing-project-id') {
              return status(400, 'missing origin');
            }
            if (outcome.status === 'timestamp-too-old') {
              return status(400, TRACK_REJECTION_MESSAGES['timestamp-too-old']);
            }

            return status(ACCEPTED_STATUS, 'ok');
          },
          {
            clientAuth: { ingest: validateIngestRequest },
            // Recorded after `clientAuth` resolves the client and before the
            // hooks that can short-circuit, so a dropped event still counts.
            beforeHandle: [
              ({ client }: { client: { id: string } }) => {
                recordLegacyEventRequest(client.id);
              },
              botGuard,
              blockWhenWoundDown,
            ],
            detail: {
              tags: LEGACY_EVENT_TAGS,
              description:
                'Deprecated direct event ingestion endpoint. Use /track instead.',
            },
          }
        )
  );
});
