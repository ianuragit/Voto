import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { log } from '../logging.js';
import type { EmailBody } from './templates.js';

/**
 * §9 — outbound mail over SMTP.
 *
 * Provider-neutral: nothing here knows it is talking to ZeptoMail. For
 * ZeptoMail specifically the relay is `smtp.zeptomail.com` (or
 * `smtp.zeptomail.in`), the username is the literal string `emailapikey`, and
 * the password is the Mail Agent's SMTP token — a different credential from
 * the Send Mail API token. Confirm against current documentation at deploy
 * time.
 *
 * PRIVACY NOTE, and it matters more over SMTP than it did over the API.
 * The API accepted `track_clicks: false` / `track_opens: false` on every
 * request, so tracking was disabled per-message in code. SMTP has no such
 * parameter: **the Mail Agent's own tracking settings are now the only
 * control.** A tracked link would create a server-side record tying a person
 * to the moment they opened their ballot, which is exactly what §6.2 exists to
 * prevent — so click and open tracking must be turned off in the provider
 * console, and `npm run check:email` warns that this cannot be enforced from
 * here.
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
 * SMTP says this itself: 4xx is "try again later", 5xx is "no". Auth and TLS
 * failures are settled questions too — retrying a wrong password three times
 * just delays the report by 21 seconds.
 */
const PERMANENT_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGEID']);
const TRANSIENT_CODES = new Set([
  'ECONNECTION',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ESOCKET',
  'EDNS',
  'EAI_AGAIN',
  'EPIPE',
  'ESOCKETTIMEDOUT',
]);

export function isRetryableSmtpError(err: { responseCode?: number; code?: string }): boolean {
  if (typeof err.responseCode === 'number') {
    // 421/450/451/452 etc. are explicitly temporary; 5xx is a refusal.
    return err.responseCode >= 400 && err.responseCode < 500;
  }
  if (err.code && PERMANENT_CODES.has(err.code)) return false;
  if (err.code && TRANSIENT_CODES.has(err.code)) return true;
  // An unrecognised failure gets the benefit of the doubt, once.
  return true;
}

/**
 * §6.3 — what we are allowed to keep from a failure.
 *
 * The SMTP reply code and nodemailer's error code name the problem precisely
 * and carry no personal data. The server's reply *text* is dropped: a rejected
 * recipient is commonly echoed back inside it ("550 5.1.1 <priya@example.com>
 * unknown"), and that would put an address in the logs. The scrubber in
 * `logging.ts` is the backstop if that ever slips through.
 */
export function describeSmtpFailure(err: { responseCode?: number; code?: string }): string {
  const parts = ['smtp'];
  if (typeof err.responseCode === 'number') parts.push(String(err.responseCode));
  if (typeof err.code === 'string') parts.push(err.code);
  return parts.length > 1 ? parts.join('_') : 'smtp_send_failed';
}

let transporter: Transporter | null = null;

function smtpTransporter(): Transporter {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.smtpSecure, // 465 implicit TLS, otherwise STARTTLS
    requireTLS: !config.smtpSecure, // never fall back to an unencrypted session
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    // A poll sends N invites at once; one pooled connection is plenty for
    // N <= 25 and avoids a fresh TLS handshake per recipient.
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    // Nodemailer's own logging would print recipients and message content.
    logger: false,
    debug: false,
  });
  return transporter;
}

/** Closes the pool. Tests and shutdown only. */
export function closeTransporter(): void {
  transporter?.close();
  transporter = null;
}

const smtpTransport: Transport = async (to, body) => {
  try {
    await smtpTransporter().sendMail({
      from: { address: config.MAIL_FROM_ADDRESS, name: config.MAIL_FROM_NAME },
      to,
      subject: body.subject,
      text: body.text,
      html: body.html,
      // Bounces go to the envelope sender, which is what the provider's
      // webhook reports on — not to the human-facing From address.
      ...(config.MAIL_BOUNCE_ADDRESS
        ? { envelope: { from: config.MAIL_BOUNCE_ADDRESS, to } }
        : {}),
      headers: {
        'Auto-Submitted': 'auto-generated',
        // Ballots are not a mailing list, but they are automated: this stops
        // vacation responders from replying to every invite.
        Precedence: 'bulk',
      },
    });
    return { ok: true };
  } catch (err) {
    const e = (err ?? {}) as { responseCode?: number; code?: string };
    return { ok: false, error: describeSmtpFailure(e), retryable: isRetryableSmtpError(e) };
  }
};

/** Development / test transport: prints subjects only, never the body. */
const dryRunTransport: Transport = async (_to, body) => {
  process.stdout.write(`[email:dry-run] ${body.subject}\n`);
  return { ok: true };
};

let override: Transport | null = null;

/** Tests and local runs swap the transport; production never calls this. */
export function setTransport(next: Transport | null): void {
  override = next;
}

function activeTransport(): Transport {
  if (override) return override;
  return config.emailDryRun ? dryRunTransport : smtpTransport;
}

/**
 * §9 — up to 3 attempts with exponential backoff (1s, 4s, 16s).
 *
 * A failure the server has already called permanent stops immediately: the
 * point of the backoff is to ride out a blip, not to re-ask a settled
 * question. The log line carries the SMTP reply code, because "delivery
 * failed" on its own has no next action attached to it.
 */
export async function sendEmail(to: string, body: EmailBody): Promise<SendResult> {
  const send = activeTransport();
  let last: SendResult = { ok: false, error: 'not_attempted' };
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
    last = await send(to, body);
    if (last.ok) return last;
    if (last.retryable === false) {
      log.warn('email rejected — this will not succeed on retry; check SMTP configuration', {
        reason: last.error,
      });
      return last;
    }
    if (attempt < RETRY_DELAYS_MS.length - 1) await sleep(RETRY_DELAYS_MS[attempt] ?? 1000);
  }
  log.warn('email delivery failed after retries', { reason: last.error });
  return last;
}

/**
 * Proves the relay is reachable and the credential is accepted, without
 * sending anything. Called at boot so a misconfiguration is a loud warning on
 * day one rather than a silent failure discovered when a poll cannot complete.
 *
 * It never throws: mail being down must not stop Voto serving ballots.
 */
export async function verifyMailer(): Promise<boolean> {
  if (config.emailDryRun) {
    log.warn('email is in dry-run: invites will be printed, not sent', {
      reason: config.EMAIL_DRY_RUN ? 'EMAIL_DRY_RUN' : 'smtp_not_configured',
    });
    return false;
  }
  try {
    await smtpTransporter().verify();
    log.info('smtp ready', { host: config.SMTP_HOST, port: config.SMTP_PORT });
    return true;
  } catch (err) {
    const e = (err ?? {}) as { responseCode?: number; code?: string };
    log.error('smtp is NOT working — invites will not be delivered', {
      reason: describeSmtpFailure(e),
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
    });
    return false;
  }
}
