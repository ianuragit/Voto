import { config } from './config.js';

/**
 * §6.3 — logging policy, enforced by construction rather than by convention.
 *
 * The logger accepts a message and an optional flat context object. Any key
 * that could carry voter identity or ballot content is dropped before the line
 * is written, so a careless call site cannot leak. `poll_id` is allowed.
 */

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
type Level = (typeof LEVELS)[number];

/** Never written, at any level, from anywhere. */
const FORBIDDEN_KEYS = new Set([
  'token',
  'tokens',
  'token_hash',
  'tokenhash',
  'code',
  'code_hash',
  'codehash',
  'option',
  'option_index',
  'optionindex',
  'email',
  'emails',
  'to',
  'recipient',
  'roster',
  'ip',
  'remoteaddress',
  'user_agent',
  'useragent',
  'cookie',
  'authorization',
  'body',
  'query',
  'headers',
  'counts',
  'tally',
  'tallies',
]);

/** §6.3 — these paths never produce a request log line of any kind. */
export const NO_LOG_PATH_PATTERNS = [/\/vote$/, /\/verify-code$/, /^\/v\//, /^\/c\//];

export function isNoLogPath(path: string): boolean {
  const clean = path.split('?')[0] ?? path;
  return NO_LOG_PATH_PATTERNS.some((re) => re.test(clean));
}

function scrub(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    if (typeof value === 'string' && value.includes('@')) continue; // belt and braces
    out[key] = value;
  }
  return out;
}

const threshold = LEVELS.indexOf(config.logLevel as Level);

function write(level: Level, msg: string, context?: Record<string, unknown>): void {
  if (threshold === -1 || LEVELS.indexOf(level) < threshold) return;
  const line = JSON.stringify({ level, msg, ...scrub(context) });
  if (level === 'error' || level === 'fatal') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) => write('debug', msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => write('info', msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => write('warn', msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) => write('error', msg, ctx),
};
