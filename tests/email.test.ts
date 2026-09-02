import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSmtpHost, resolveSmtpSecure } from '../src/config.js';
import {
  describeSmtpFailure,
  isRetryableSmtpError,
  sendEmail,
  setTransport,
} from '../src/email/mailer.js';
import type { EmailBody } from '../src/email/templates.js';

const body: EmailBody = { subject: 's', html: '<p>h</p>', text: 't' };

afterEach(() => {
  setTransport(null);
  vi.useRealTimers();
});

describe('SMTP settings are forgiving about how they are written', () => {
  it('accepts a host however it was copied out of the docs', () => {
    for (const raw of [
      'smtp.zeptomail.in',
      ' smtp.zeptomail.in ',
      'SMTP.ZeptoMail.in',
      'smtp://smtp.zeptomail.in',
      'https://smtp.zeptomail.in/',
      'smtp.zeptomail.in:587',
    ]) {
      expect(normalizeSmtpHost(raw)).toBe('smtp.zeptomail.in');
    }
  });

  it('derives TLS from the port, which is the pairing people get wrong', () => {
    expect(resolveSmtpSecure(465)).toBe(true); // implicit TLS
    expect(resolveSmtpSecure(587)).toBe(false); // STARTTLS
    expect(resolveSmtpSecure(2525)).toBe(false);
  });

  it('still honours an explicit override', () => {
    expect(resolveSmtpSecure(587, 'true')).toBe(true);
    expect(resolveSmtpSecure(465, 'false')).toBe(false);
    expect(resolveSmtpSecure(465, '')).toBe(true); // empty means "not set"
  });
});

describe('only transient failures are retried', () => {
  it('reads the SMTP reply code: 4xx try again, 5xx never', () => {
    for (const responseCode of [421, 450, 451, 452]) {
      expect(isRetryableSmtpError({ responseCode })).toBe(true);
    }
    for (const responseCode of [500, 535, 550, 553]) {
      expect(isRetryableSmtpError({ responseCode })).toBe(false);
    }
  });

  it('treats a refused credential as settled and a dropped socket as not', () => {
    expect(isRetryableSmtpError({ code: 'EAUTH' })).toBe(false);
    expect(isRetryableSmtpError({ code: 'EENVELOPE' })).toBe(false);
    expect(isRetryableSmtpError({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isRetryableSmtpError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isRetryableSmtpError({})).toBe(true); // unknown gets one benefit of the doubt
  });

  it('gives up immediately on a misconfiguration', async () => {
    let attempts = 0;
    setTransport(async () => {
      attempts += 1;
      return { ok: false, error: 'smtp_535_EAUTH', retryable: false };
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
      return { ok: false, error: 'smtp_451', retryable: true };
    });

    const pending = sendEmail('someone@example.com', body);
    await vi.advanceTimersByTimeAsync(30_000);

    expect((await pending).ok).toBe(false);
    expect(attempts).toBe(3);
  });

  it('stops as soon as one attempt succeeds', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    setTransport(async () => {
      attempts += 1;
      return attempts === 2 ? { ok: true } : { ok: false, error: 'smtp_421', retryable: true };
    });

    const pending = sendEmail('someone@example.com', body);
    await vi.advanceTimersByTimeAsync(30_000);

    expect((await pending).ok).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe('the failure reason names the problem but never the person', () => {
  it('keeps the reply code and the error code', () => {
    expect(describeSmtpFailure({ responseCode: 535, code: 'EAUTH' })).toBe('smtp_535_EAUTH');
    expect(describeSmtpFailure({ responseCode: 451 })).toBe('smtp_451');
    expect(describeSmtpFailure({ code: 'ECONNREFUSED' })).toBe('smtp_ECONNREFUSED');
  });

  it('never carries the server reply text, which echoes the recipient', () => {
    // A real 550 reads: "550 5.1.1 <priya@example.com>: Recipient not found".
    const reason = describeSmtpFailure({
      responseCode: 550,
      code: 'EENVELOPE',
      response: '550 5.1.1 <priya@example.com>: Recipient address rejected',
      command: 'RCPT TO',
    } as never);
    expect(reason).toBe('smtp_550_EENVELOPE');
    expect(reason).not.toContain('@');
    expect(reason).not.toContain('priya');
  });

  it('falls back to a generic reason when the error says nothing useful', () => {
    expect(describeSmtpFailure({})).toBe('smtp_send_failed');
  });
});
