import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { randomId, safeEqual } from '../domain/crypto.js';

/**
 * FR-3.1 — the vote requires an anti-CSRF token bound to the ballot page
 * render. Double-submit: the value goes into an httpOnly cookie and into the
 * form, and the server compares the two. No server-side store, so no record of
 * who rendered a ballot and when.
 */

const COOKIE = 'voto_csrf';

export function issueCsrf(reply: FastifyReply): string {
  const value = randomId(24);
  reply.setCookie(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: 3600,
  });
  return value;
}

export function checkCsrf(req: FastifyRequest, submitted: string | undefined): boolean {
  const cookie = req.cookies?.[COOKIE];
  if (!cookie || !submitted) return false;
  return safeEqual(cookie, submitted);
}
