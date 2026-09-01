import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeZeptoMailUrl } from '../src/config.js';
import { describeFailure, isRetryable, sendEmail, setTransport } from '../src/email/zeptomail.js';
import type { EmailBody } from '../src/email/templates.js';

const body: EmailBody = { subject: 's', html: '<p>h</p>', text: 't' };

afterEach(() => {
  setTransport(null);
  vi.useRealTimers();
});

describe('the send endpoint is forgiving about how it is configured', () => {
  it('accepts a bare host and appends the send path', () => {
    // The regions differ only in host, so pasting just the host is the
    // obvious mistake — and the provider answers it with a bare 404.
    for (const host of ['https://api.zeptomail.com', 'https://api.zeptomail.in']) {
      expect(normalizeZeptoMailUrl(host)).toBe(`${host}/v1.1/email`);
      expect(normalizeZeptoMailUrl(`${host}/`)).toBe(`${host}/v1.1/email`);
    }
  });

  it('strips a trailing slash, which the provider rejects with 403', () => {
    expect(normalizeZeptoMailUrl('https://api.zeptomail.in/v1.1/email/')).toBe(
      'https://api.zeptomail.in/v1.1/email',
    );
  });

  it('leaves a correct URL alone', () => {
    const url = 'https://api.zeptomail.com/v1.1/email';
    expect(normalizeZeptoMailUrl(url)).toBe(url);
  });

  it('rejects something that is not a URL at all', () => {
    expect(() => normalizeZeptoMailUrl('api.zeptomail.in')).toThrow();
  });
});

describe('only transient failures are retried', () => {
  it('classifies provider statuses', () => {
    for (const status of [400, 401, 403, 404, 422]) expect(isRetryable(status)).toBe(false);
    for (const status of [408, 429, 500, 502, 503]) expect(isRetryable(status)).toBe(true);
  });

  it('gives up immediately on a misconfiguration', async () => {
    let attempts = 0;
    setTransport(async () => {
      attempts += 1;
      return { ok: false, error: 'zeptomail_http_404', retryable: false };
    });

    const result = await sendEmail('someone@example.com', body);

    expect(attempts).toBe(1); // not 3, and no 21 seconds of backoff
    expect(result.ok).toBe(false);
  });

  it('still retries a transient failure three times', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    setTransport(async () => {
      attempts += 1;
      return { ok: false, error: 'zeptomail_http_503', retryable: true };
    });

    const pending = sendEmail('someone@example.com', body);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(attempts).toBe(3);
    expect(result.ok).toBe(false);
  });

  it('stops as soon as one attempt succeeds', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    setTransport(async () => {
      attempts += 1;
      return attempts === 2 ? { ok: true } : { ok: false, error: 'boom', retryable: true };
    });

    const pending = sendEmail('someone@example.com', body);
    await vi.advanceTimersByTimeAsync(30_000);

    expect((await pending).ok).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe('the provider error is preserved, the recipient is not', () => {
  const asResponse = (status: number, payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status });

  it('keeps the codes that name the problem', async () => {
    const reason = await describeFailure(
      asResponse(401, {
        error: {
          code: 'TM_4001',
          message: 'Access Denied',
          details: [{ code: 'SERR_157', message: 'Invalid API Token found' }],
        },
      }),
    );
    expect(reason).toContain('zeptomail_http_401');
    expect(reason).toContain('TM_4001');
    expect(reason).toContain('SERR_157');
    expect(reason).toContain('Access Denied');
  });

  it('never keeps details[].message, which can echo the address', async () => {
    const reason = await describeFailure(
      asResponse(400, {
        error: {
          code: 'TM_3201',
          message: 'Invalid Recipient',
          details: [{ code: 'SERR_112', message: 'priya@example.com is not a valid address' }],
        },
      }),
    );
    expect(reason).toContain('TM_3201');
    expect(reason).toContain('SERR_112');
    expect(reason).not.toContain('priya@example.com');
    expect(reason).not.toContain('@');
  });

  it('falls back to the status when the body is not the documented shape', async () => {
    expect(await describeFailure(new Response('<html>nope</html>', { status: 502 }))).toBe(
      'zeptomail_http_502',
    );
  });
});
