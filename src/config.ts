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

  ZEPTOMAIL_API_URL: z.string().url().default('https://api.zeptomail.com/v1.1/email'),
  ZEPTOMAIL_API_KEY: z.string().default(''),
  ZEPTOMAIL_FROM_ADDRESS: z.string().default(''),
  ZEPTOMAIL_FROM_NAME: z.string().default('Voto'),
  ZEPTOMAIL_BOUNCE_ADDRESS: z.string().default(''),
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
};

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

  const dryRun = parsed.EMAIL_DRY_RUN || parsed.ZEPTOMAIL_API_KEY === '';

  return {
    ...parsed,
    isProduction,
    // §6.3 — production logs at warn.
    logLevel: parsed.LOG_LEVEL ?? (isProduction ? 'warn' : 'info'),
    emailDryRun: dryRun,
  };
}

export const config: Config = build();
export const buildConfig = build;
