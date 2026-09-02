import { z } from 'zod';

/**
 * Environment configuration. Nothing secret is ever hard-coded; everything
 * lives in Railway env vars (see README §"Railway setup").
 */

const emailList = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(/[,\n;]/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v)));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  /** Public origin used to build magic links, e.g. https://voto.up.railway.app */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  /** Directory holding auth.sqlite and tally.sqlite (Railway volume mount). */
  DATA_DIR: z.string().default('./data'),

  /** HMAC key for creator sessions, sign-in links and CSRF. Required in production. */
  SESSION_SECRET: z.string().min(16).default('dev-only-insecure-secret-change-me'),

  /** Comma-separated emails allowed to create polls (§12 Q1). */
  ALLOWED_CREATORS: emailList,

  /**
   * SMTP. The names are provider-neutral on purpose: nothing below is
   * ZeptoMail-specific, so moving to another relay is a variable change and
   * not a code change.
   *
   * For ZeptoMail the host is `smtp.zeptomail.com` (or `smtp.zeptomail.in` for
   * India-region accounts), the username is the literal string `emailapikey`,
   * and the password is the Mail Agent's **SMTP** token — which is a different
   * credential from the Send Mail API token. Confirm against current ZeptoMail
   * documentation when you configure it.
   */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().max(65535).default(587),
  /** Omit to derive from the port: 465 is implicit TLS, everything else STARTTLS. */
  SMTP_SECURE: z.string().optional(),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),

  MAIL_FROM_ADDRESS: z.string().default(''),
  MAIL_FROM_NAME: z.string().default('Voto'),
  /** Envelope sender (Return-Path). Bounces come back here, not to the From. */
  MAIL_BOUNCE_ADDRESS: z.string().default(''),

  ZEPTOMAIL_WEBHOOK_SECRET: z.string().default(''),
  /** Header carrying the webhook HMAC signature. */
  ZEPTOMAIL_WEBHOOK_SIGNATURE_HEADER: z.string().default('x-zoho-signature'),

  /** When true (or when no API key is set) emails are written to stdout, not sent. */
  EMAIL_DRY_RUN: boolish(false),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
  logLevel: string;
  emailDryRun: boolean;
  smtpSecure: boolean;
};

/**
 * Accepts what people actually paste into a host field. A relay is given as a
 * hostname, but it is routinely copied from documentation as a URL or with a
 * port stuck on the end, and every one of those spellings should work rather
 * than fail later as invites that never arrive.
 *
 *   smtp.zeptomail.in          -> smtp.zeptomail.in
 *   smtp://smtp.zeptomail.in   -> smtp.zeptomail.in
 *   https://smtp.zeptomail.in/ -> smtp.zeptomail.in
 *   smtp.zeptomail.in:587      -> smtp.zeptomail.in  (the port has its own var)
 */
export function normalizeSmtpHost(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // strip any scheme
    .replace(/\/.*$/, '') // strip a path
    .replace(/:\d+$/, '') // strip a port
    .toLowerCase();
}

/**
 * Implicit TLS on 465, STARTTLS everywhere else. Getting this pair wrong is
 * the classic SMTP misconfiguration — `secure: true` on 587 hangs until it
 * times out — so it is derived from the port unless explicitly overridden.
 */
export function resolveSmtpSecure(port: number, override?: string): boolean {
  if (override !== undefined && override !== '') return /^(1|true|yes|on)$/i.test(override);
  return port === 465;
}

function build(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  const isProduction = parsed.NODE_ENV === 'production';

  if (isProduction) {
    if (parsed.SESSION_SECRET === 'dev-only-insecure-secret-change-me') {
      throw new Error('SESSION_SECRET must be set in production');
    }
    if (parsed.ALLOWED_CREATORS.length === 0) {
      throw new Error('ALLOWED_CREATORS must list at least one email in production');
    }
  }

  // Without a host or credentials there is nothing to send through, so Voto
  // prints mail instead of pretending to deliver it.
  const smtpConfigured =
    parsed.SMTP_HOST !== '' && parsed.SMTP_USER !== '' && parsed.SMTP_PASSWORD !== '';
  const dryRun = parsed.EMAIL_DRY_RUN || !smtpConfigured;

  return {
    ...parsed,
    SMTP_HOST: normalizeSmtpHost(parsed.SMTP_HOST),
    isProduction,
    // §6.3 — production logs at warn.
    logLevel: parsed.LOG_LEVEL ?? (isProduction ? 'warn' : 'info'),
    emailDryRun: dryRun,
    smtpSecure: resolveSmtpSecure(parsed.SMTP_PORT, parsed.SMTP_SECURE),
  };
}

export const config: Config = build();
export const buildConfig = build;
