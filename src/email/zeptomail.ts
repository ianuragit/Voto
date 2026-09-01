import { config } from '../config.js';
import { log } from '../logging.js';
import type { EmailBody } from './templates.js';

/**
 * §9 — ZeptoMail transactional send.
 *
 * Verify the endpoint, header scheme and payload shape against current
 * ZeptoMail documentation at deploy time; the shape below matches the v1.1
 * transactional API as documented at the time of writing. Auth uses Zoho's
 * `Zoho-enczapikey <token>` scheme, not a bearer token.
 *
 * Open and click tracking are explicitly disabled — a tracked link would
 * create a server-side record tying a person to the moment they engaged with
 * their ballot, which is precisely what §6.2 exists to prevent.
 */

const RETRY_DELAYS_MS = [1000, 4000, 16000];

export interface SendResult {
  ok: boolean;
  error?: string;
  /** False for a misconfiguration: another attempt cannot change the answer. */
  retryable?: boolean;
}

export type Transport = (to: string, body: EmailBody) => Promise<SendResult>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Only transient conditions are worth another attempt. A 400/401/403/404 is a
 * misconfiguration: retrying it three times with backoff turns one clear
 * failure into 21 wasted seconds per recipient and still never delivers.
 */
export function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * ZeptoMail answers a failure with
 *   {"error":{"code":"TM_4001","message":"Access Denied",
 *             "details":[{"code":"SERR_157","message":"Invalid API Token found"}]}}
 *
 * Those codes name the problem exactly, and a bare `http_404` does not — so we
 * keep them. We keep the top-level message and the `details[].code`s, but never
 * `details[].message`, which for a rejected recipient echoes the address.
 * §6.3's scrubber is the second line of defence if that ever changes.
 */
export async function describeFailure(res: Response): Promise<string> {
  const base = `zeptomail_http_${res.status}`;
  try {
    const body = (await res.json()) as {
      error?: { code?: unknown; message?: unknown; details?: { code?: unknown }[] };
    };
    const err = body?.error;
    if (!err) return base;
    const codes = Array.isArray(err.details)
      ? err.details.map((d) => d?.code).filter((c): c is string => typeof c === 'string')
      : [];
    return [
      base,
      typeof err.code === 'string' ? err.code : '',
      codes.join(','),
      typeof err.message === 'string' ? err.message : '',
    ]
      .filter(Boolean)
      .join(' ');
  } catch {
    return base;
  }
}

async function sendOnce(to: string, body: EmailBody): Promise<SendResult> {
  const payload = {
    from: { address: config.ZEPTOMAIL_FROM_ADDRESS, name: config.ZEPTOMAIL_FROM_NAME },
    to: [{ email_address: { address: to } }],
    subject: body.subject,
    htmlbody: body.html,
    textbody: body.text,
    track_clicks: false,
    track_opens: false,
    ...(config.ZEPTOMAIL_BOUNCE_ADDRESS ? { bounce_address: config.ZEPTOMAIL_BOUNCE_ADDRESS } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(config.ZEPTOMAIL_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Zoho-enczapikey ${config.ZEPTOMAIL_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: await describeFailure(res), retryable: isRetryable(res.status) };
  } catch (err) {
    // Network failure or timeout — worth another go.
    return { ok: false, error: err instanceof Error ? err.name : 'send_failed', retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

/** Development / test transport: prints subjects only, never the body. */
const dryRunTransport: Transport = async (_to, body) => {
  process.stdout.write(`[email:dry-run] ${body.subject}\n`);
  return { ok: true };
};

let transport: Transport | null = null;

/** Tests and local runs swap the transport; production never calls this. */
export function setTransport(next: Transport | null): void {
  transport = next;
}

function activeTransport(): Transport {
  if (transport) return transport;
  return config.emailDryRun ? dryRunTransport : sendOnce;
}

/**
 * §9 — up to 3 attempts with exponential backoff (1s, 4s, 16s).
 *
 * A failure the provider has already called permanent stops immediately: the
 * point of the backoff is to ride out a blip, not to re-ask a settled
 * question. The log line carries the provider's own error codes, because
 * "delivery failed" on its own has no next action attached to it.
 */
export async function sendEmail(to: string, body: EmailBody): Promise<SendResult> {
  const send = activeTransport();
  let last: SendResult = { ok: false, error: 'not_attempted' };
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    last = await send(to, body);
    if (last.ok) return last;
    if (last.retryable === false) {
      log.warn('email rejected — this will not succeed on retry; check configuration', {
        reason: last.error,
      });
      return last;
    }
    if (attempt < RETRY_DELAYS_MS.length - 1) await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
  }
  log.warn('email delivery failed after retries', { reason: last.error });
  return last;
}
