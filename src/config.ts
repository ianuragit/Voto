import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export function localInterfaceAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .map((n) => n.address);
}

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
  /**
   * True when this is a real deployment, however NODE_ENV happens to be set.
   * Everything security-relevant keys off this rather than off NODE_ENV,
   * because a deployment running with NODE_ENV=development silently drops the
   * Secure flag from cookies, drops HSTS, and skips the secret checks — which
   * is not a thing anyone would choose, only a thing they would miss.
   */
  isDeployed: boolean;
  /** The address actually bound, after rejecting one this machine cannot use. */
  bindHost: string;
  /** DATA_DIR is not an absolute path, so it dies with the container. */
  dataIsEphemeral: boolean;
  logLevel: string;
  emailDryRun: boolean;
  smtpSecure: boolean;
};

const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '*']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Platform markers. A container on a PaaS is production whatever NODE_ENV
 * says; asking the environment is more reliable than asking a string someone
 * had to remember to set.
 */
export function detectDeployment(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === 'production') return true;
  if (env.NODE_ENV === 'test') return false;
  return Object.keys(env).some(
    (key) =>
      key.startsWith('RAILWAY_') ||
      key === 'DYNO' ||
      key === 'FLY_APP_NAME' ||
      key === 'RENDER' ||
      key === 'KUBERNETES_SERVICE_HOST',
  );
}

/**
 * Binding to an address the machine does not hold fails with EADDRNOTAVAIL and
 * the container never starts. On a PaaS the only correct answer is every
 * interface, so a HOST that is not a wildcard, not loopback, and not an
 * address on a local interface is refused in favour of 0.0.0.0.
 *
 * Returns the host to bind and, when it differs, why.
 */
export function resolveBindHost(
  requested: string,
  localAddresses: string[],
): { host: string; rejected: string | null } {
  const host = requested.trim();
  if (WILDCARD_HOSTS.has(host)) return { host: host === '' ? '0.0.0.0' : host, rejected: null };
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return { host, rejected: null };
  if (localAddresses.includes(host)) return { host, rejected: null };
  return { host: '0.0.0.0', rejected: host };
}

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
  const isDeployed = detectDeployment(env);

  // Keyed to isDeployed, not to NODE_ENV. The default secret is published in
  // this repository, so a deployment running on it lets anyone forge a creator
  // session — refusing to boot is the only safe answer, and it says why.
  if (isDeployed) {
    if (parsed.SESSION_SECRET === 'dev-only-insecure-secret-change-me') {
      throw new Error(
        'SESSION_SECRET is still the built-in development value, which is public in this ' +
          'repository — anyone could forge a creator session. Set it to 48 random bytes ' +
          '(openssl rand -base64 48) and redeploy.',
      );
    }
    if (parsed.ALLOWED_CREATORS.length === 0) {
      throw new Error(
        'ALLOWED_CREATORS is empty, so nobody can create a poll. Set it to a comma-separated ' +
          'list of the addresses allowed to convene votes.',
      );
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
    isDeployed,
    bindHost: resolveBindHost(parsed.HOST, localInterfaceAddresses()).host,
    dataIsEphemeral: !path.isAbsolute(parsed.DATA_DIR),
    // §6.3 — a deployment logs at warn, whatever NODE_ENV says.
    logLevel: parsed.LOG_LEVEL ?? (isDeployed ? 'warn' : 'info'),
    emailDryRun: dryRun,
    smtpSecure: resolveSmtpSecure(parsed.SMTP_PORT, parsed.SMTP_SECURE),
  };
}

export const config: Config = build();
export const buildConfig = build;
