import { describe, expect, it } from 'bun:test';
import { postWebhook, type WebhookFetcher } from './fetcher';

const URL = 'https://hooks.example.com/notify';

function respondingWith(status: number): WebhookFetcher {
  return async () => ({ status });
}

describe('postWebhook', () => {
  it('reports a 2xx as delivered', async () => {
    expect(await postWebhook(respondingWith(204), URL, {})).toEqual({
      ok: true,
      status: 204,
      retryable: false,
    });
  });

  it('marks 408, 429 and 5xx as retryable so the queue backs off and retries', async () => {
    for (const status of [408, 429, 500, 502, 503]) {
      const result = await postWebhook(respondingWith(status), URL, {});
      expect(result).toEqual({ ok: false, status, retryable: true });
    }
  });

  it('marks any other 4xx as permanent', async () => {
    for (const status of [400, 401, 403, 404, 410, 422]) {
      const result = await postWebhook(respondingWith(status), URL, {});
      expect(result).toEqual({ ok: false, status, retryable: false });
    }
  });

  it('treats no response at all (timeout, DNS, connect) as retryable', async () => {
    const failing: WebhookFetcher = async () => {
      throw new Error('The operation timed out.');
    };
    expect(await postWebhook(failing, URL, {})).toEqual({
      ok: false,
      status: 0,
      retryable: true,
    });
  });

  it('posts the body as JSON with the extra headers', async () => {
    let seen: Parameters<WebhookFetcher> | undefined;
    const recording: WebhookFetcher = async (...args) => {
      seen = args;
      return { status: 200 };
    };
    await postWebhook(recording, URL, { a: 1 }, { 'x-signature': 'sig' });
    expect(seen?.[0]).toBe(URL);
    expect(seen?.[1]).toEqual({
      method: 'POST',
      headers: { 'x-signature': 'sig', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
  });
});
