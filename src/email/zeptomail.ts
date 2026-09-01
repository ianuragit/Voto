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
}

export type Transport = (to: string, body: EmailBody) => Promise<SendResult>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    // Never log the response body: it echoes the recipient address.
    return { ok: false, error: `zeptomail_http_${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.name : 'send_failed' };
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

/** §9 — 3 attempts, exponential backoff (1s, 4s, 16s), then hard failure. */
export async function sendEmail(to: string, body: EmailBody): Promise<SendResult> {
  const send = activeTransport();
  let last: SendResult = { ok: false, error: 'not_attempted' };
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    last = await send(to, body);
    if (last.ok) return last;
    if (attempt < RETRY_DELAYS_MS.length - 1) await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
  }
  log.warn('email delivery failed after retries', { reason: last.error });
  return last;
}
