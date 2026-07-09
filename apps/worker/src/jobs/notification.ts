import { type Job, UnrecoverableError } from 'bullmq';

import { Prisma, db } from '@openpanel/db';
import { sendDiscordNotification } from '@openpanel/integrations/src/discord';
import { sendSlackNotification } from '@openpanel/integrations/src/slack';
import { execute as executeJavaScriptTemplate } from '@openpanel/js-runtime';
import type { NotificationQueuePayload } from '@openpanel/queue';
import { publishEvent } from '@openpanel/redis';

function isValidJson<T>(
  value: T | Prisma.NullableJsonNullValueInput | null | undefined,
): value is T {
  return (
    value !== null &&
    value !== undefined &&
    value !== Prisma.JsonNull &&
    value !== Prisma.DbNull
  );
}

export async function notificationJob(job: Job<NotificationQueuePayload>) {
  switch (job.data.type) {
    case 'sendNotification': {
      const { notification } = job.data.payload;

      if (notification.sendToApp) {
        publishEvent('notification', 'created', notification);
        return;
      }

      if (notification.sendToEmail) {
        return;
      }

      if (!notification.integrationId) {
        throw new Error('No integrationId provided');
      }

      const integration = await db.integration.findUniqueOrThrow({
        where: {
          id: notification.integrationId,
        },
      });

      const payload = notification.payload;

      if (!isValidJson(payload)) {
        return new Error('Invalid payload');
      }

      switch (integration.config.type) {
        case 'webhook': {
          let body: unknown;

          if (integration.config.mode === 'javascript') {
            // We only transform event payloads for now (not funnel)
            if (
              integration.config.javascriptTemplate &&
              payload.type === 'event'
            ) {
              const result = executeJavaScriptTemplate(
                integration.config.javascriptTemplate,
                payload.event,
              );
              body = result;
            } else {
              body = payload;
            }
          } else {
            body = {
              title: notification.title,
              message: notification.message,
            };
          }

          const res = await fetch(integration.config.url, {
            method: 'POST',
            headers: {
              ...(integration.config.headers ?? {}),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
          });
          if (res.ok) {
            return;
          }
          const err = `Webhook ${integration.config.url} returned ${res.status}`;
          // 4xx (except 408/429) are permanent — the same request will fail
          // identically on every retry, so mark the job unrecoverable and
          // stop BullMQ from burning its retry budget.
          if (
            res.status >= 400 &&
            res.status < 500 &&
            res.status !== 408 &&
            res.status !== 429
          ) {
            throw new UnrecoverableError(err);
          }
          throw new Error(err);
        }
        case 'discord': {
          return sendDiscordNotification({
            webhookUrl: integration.config.url,
            message: [
              `🔔 **${notification.title}**`,
              notification.message,
            ].join('\n'),
          });
        }

        case 'slack': {
          return sendSlackNotification({
            webhookUrl: integration.config.incoming_webhook.url,
            message: [`🔔 *${notification.title}*`, notification.message].join(
              '\n',
            ),
          });
        }
      }
    }
  }
}
