import { config } from '../config.js';
import { hmac } from '../domain/crypto.js';

/**
 * FR-3.7 / §6.2.4 — rate-limit state lives in memory with a short TTL and is
 * never persisted. IP addresses are not stored even here: the key is an HMAC
 * of the address under the session secret, so a heap dump yields no addresses.
 *
 * Single replica (§7.1), so an in-process map is the whole story.
 */

const WINDOW_MS = 60_000;
const TTL_MS = 15 * 60_000;

interface Bucket {
  hits: number[];
  touched: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number): void {
  if (now - lastSweep < TTL_MS) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (now - bucket.touched > TTL_MS) buckets.delete(key);
  }
}

function keyFor(scope: string, value: string): string {
  return `${scope}:${hmac(config.SESSION_SECRET, value).slice(0, 32)}`;
}

function hit(key: string, limit: number, now: number): boolean {
  const bucket = buckets.get(key) ?? { hits: [], touched: now };
  bucket.hits = bucket.hits.filter((t) => now - t < WINDOW_MS);
  bucket.touched = now;
  if (bucket.hits.length >= limit) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.hits.push(now);
  buckets.set(key, bucket);
  return true;
}

/** 10 requests/min per IP on ballot and vote endpoints; 30/min per poll. */
export function allow(input: { ip: string; pollId?: string; scope: string }): boolean {
  const now = Date.now();
  sweep(now);
  const ipOk = hit(keyFor(`ip:${input.scope}`, input.ip), 10, now);
  if (!ipOk) return false;
  if (input.pollId) return hit(keyFor('poll', input.pollId), 30, now);
  return true;
}

/**
 * FR-2.2 — code entry gets its own tighter budget: 5 failures per poll per
 * client per hour, on top of the per-IP limit above.
 */
const CODE_WINDOW_MS = 3600_000;
const codeFailures = new Map<string, { count: number; until: number }>();

export function codeAttemptAllowed(pollId: string, ip: string): boolean {
  const key = keyFor('code', `${pollId}|${ip}`);
  const entry = codeFailures.get(key);
  if (!entry) return true;
  if (Date.now() > entry.until) {
    codeFailures.delete(key);
    return true;
  }
  return entry.count < 5;
}

export function recordCodeFailure(pollId: string, ip: string): void {
  const key = keyFor('code', `${pollId}|${ip}`);
  const now = Date.now();
  const entry = codeFailures.get(key);
  if (!entry || now > entry.until) {
    codeFailures.set(key, { count: 1, until: now + CODE_WINDOW_MS });
    return;
  }
  entry.count += 1;
  codeFailures.set(key, entry);
}

/** Test seam. */
export function resetRateLimits(): void {
  buckets.clear();
  codeFailures.clear();
}
