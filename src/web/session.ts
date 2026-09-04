import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { hmac, safeEqual } from '../domain/crypto.js';

/**
 * §8 "Creator authentication" — an env-var allowlist plus a magic-link console
 * session. No passwords, no user table, nothing to leak. The session is an
 * HMAC-signed payload in an httpOnly cookie; the server keeps no session store.
 */

const COOKIE = 'voto_session';
const SESSION_TTL_MS = 24 * 3600_000;
const SIGNIN_TTL_MS = 15 * 60_000;

interface Payload {
  email: string;
  exp: number;
  purpose: 'session' | 'signin';
}

function sign(payload: Payload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(config.SESSION_SECRET, body)}`;
}

function verify(value: string, purpose: Payload['purpose']): string | null {
  const [body, sig] = value.split('.');
  if (!body || !sig) return null;
  if (!safeEqual(sig, hmac(config.SESSION_SECRET, body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    if (payload.purpose !== purpose) return null;
    if (Date.now() > payload.exp) return null;
    return payload.email;
  } catch {
    return null;
  }
}

export function mintSignInToken(email: string): string {
  return sign({ email: email.toLowerCase(), exp: Date.now() + SIGNIN_TTL_MS, purpose: 'signin' });
}

export function redeemSignInToken(token: string): string | null {
  return verify(token, 'signin');
}

export function setSession(reply: FastifyReply, email: string): void {
  reply.setCookie(
    COOKIE,
    sign({ email: email.toLowerCase(), exp: Date.now() + SESSION_TTL_MS, purpose: 'session' }),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isDeployed, // a real deployment is HTTPS, whatever NODE_ENV says
      path: '/',
      maxAge: SESSION_TTL_MS / 1000,
    },
  );
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

export function currentCreator(req: FastifyRequest): string | null {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  const email = verify(raw, 'session');
  if (!email) return null;
  // The allowlist is re-checked on every request, so revoking is just an env change.
  return config.ALLOWED_CREATORS.includes(email) ? email : null;
}
