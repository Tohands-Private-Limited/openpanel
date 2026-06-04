import {
  TRACK_BATCH_MAX_EVENTS,
  zTrackBatchBody,
  zTrackBatchHandlerPayload,
  zTrackHandlerPayload,
} from '@openpanel/validation';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZodOpenApi } from 'fastify-zod-openapi';
import { z } from 'zod';
import {
  batchHandler,
  fetchDeviceId,
  handler,
} from '@/controllers/track.controller';
import { clientHook } from '@/hooks/client.hook';
import { duplicateHook } from '@/hooks/duplicate.hook';
import { isBotHook } from '@/hooks/is-bot.hook';

// Body limit for batch-capable routes: 10 MB uncompressed, matching the
// stated public contract ("up to 2000 events and 10 MB per request").
const TRACK_BATCH_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

// Shared 202 response schema for batch ingestion (both transports).
const zBatchResponse = z.object({
  accepted: z.number().int().min(0),
  rejected: z.array(
    z.object({
      index: z.number().int().min(0),
      reason: z.enum(['validation', 'internal']),
      error: z.string(),
    }),
  ),
});

// The 100 ms body-hash dedup only runs for single events — offline-first
// SDKs retry whole batches, and dropping a retried batch on hash collision
// is the opposite of what we want.
const singleEventDuplicateHook = async (
  request: FastifyRequest,
  reply: FastifyReply,
) => {
  const body = request.body as { type?: string } | undefined;
  if (body?.type === 'batch') {
    return;
  }
  return duplicateHook(request as Parameters<typeof duplicateHook>[0], reply);
};

const trackRouter: FastifyPluginAsyncZodOpenApi = async (fastify) => {
  fastify.addHook('preHandler', clientHook);
  fastify.addHook('preHandler', isBotHook);

  await fastify.route({
    method: 'POST',
    url: '/',
    bodyLimit: TRACK_BATCH_BODY_LIMIT_BYTES,
    preValidation: singleEventDuplicateHook,
    schema: {
      body: z
        .union([zTrackHandlerPayload, zTrackBatchHandlerPayload])
        .and(
          z.object({
            clientId: z.string().optional(),
            clientSecret: z.string().optional(),
          }),
        ),
      tags: ['Track'],
      description: `Ingest a tracking event (track, identify, group, increment, decrement, replay) or a batch of events ({ "type": "batch", "payload": [event, ...] }). Batch requests accept up to ${TRACK_BATCH_MAX_EVENTS} events and 10MB uncompressed per request; each event is dispatched through the same pipeline as a single-event request. Per-event validation failures are returned in the rejected[] array — the whole batch does not fail on a single bad row.`,
      response: {
        200: z.object({
          deviceId: z.string(),
          sessionId: z.string(),
        }),
        202: zBatchResponse,
      },
    },
    handler,
  });

  await fastify.route({
    method: 'POST',
    url: '/batch',
    bodyLimit: TRACK_BATCH_BODY_LIMIT_BYTES,
    schema: {
      deprecated: true,
      body: zTrackBatchBody,
      tags: ['Track'],
      description: `Deprecated — use POST /track with { "type": "batch", "payload": [event, ...] } instead. Same semantics: up to ${TRACK_BATCH_MAX_EVENTS} events and 10MB uncompressed per request, per-event validation failures reported in rejected[].`,
      response: {
        202: zBatchResponse,
      },
    },
    handler: batchHandler,
  });

  await fastify.route({
    method: 'GET',
    url: '/device-id',
    schema: {
      tags: ['Track'],
      description:
        'Get or generate a stable device ID and session ID for the current visitor.',
      response: {
        200: z.object({
          deviceId: z.string(),
          sessionId: z.string(),
          message: z.string().optional(),
        }),
      },
    },
    handler: fetchDeviceId,
  });
};

export default trackRouter;
