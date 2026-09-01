import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import * as authRepo from '../src/repos/authRepo.js';
import { hashToken } from '../src/domain/crypto.js';
import { resetRateLimits } from '../src/web/rateLimit.js';
import { clearMail, flush, installCapturingTransport, makePoll } from './helpers.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  installCapturingTransport();
  clearMail();
  resetRateLimits();
});

/** Pulls the CSRF cookie and the hidden field out of a rendered page. */
function jar(headers: Record<string, unknown>): string {
  const raw = headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return list.map((c) => String(c).split(';')[0]).join('; ');
}

function hiddenField(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  return match?.[1] ?? '';
}

/** The full two-tap flow a voter actually walks through. */
async function voteThroughTheUi(pollId: string, token: string, optionIndex: number) {
  const ballot = await app.inject({ method: 'GET', url: `/v/${token}` });
  const cookies = jar(ballot.headers as Record<string, unknown>);
  const csrf = hiddenField(ballot.body, 'csrf');

  const confirm = await app.inject({
    method: 'POST',
    url: `/api/polls/${pollId}/confirm`,
    headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ token, option_index: String(optionIndex), csrf }).toString(),
  });

  const confirmCookies = jar(confirm.headers as Record<string, unknown>) || cookies;
  const confirmCsrf = hiddenField(confirm.body, 'csrf');

  const cast = await app.inject({
    method: 'POST',
    url: `/api/polls/${pollId}/vote`,
    headers: { cookie: confirmCookies, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      token,
      option_index: String(optionIndex),
      csrf: confirmCsrf,
    }).toString(),
  });

  return { ballot, confirm, cast };
}

describe('the ballot flow', () => {
  it('renders read-only, confirms on a second tap, then consumes exactly once', async () => {
    const { pollId, invites } = await makePoll();
    const token = invites[0]!.token;

    const { ballot, confirm, cast } = await voteThroughTheUi(pollId, token, 0);

    expect(ballot.statusCode).toBe(200);
    expect(ballot.body).toContain('Nothing is cast yet');
    expect(confirm.statusCode).toBe(200);
    expect(confirm.body).toContain('You are about to vote for');
    expect(cast.statusCode).toBe(200);
    expect(cast.body).toContain('Your vote is in');

    expect(authRepo.countConsumed(pollId)).toBe(1);

    // FR-3.4 — the same link again is a 409 in plain language.
    const again = await voteThroughTheUi(pollId, token, 0);
    expect(again.ballot.statusCode).toBe(409);
    expect(again.ballot.body).toContain('You&#39;ve already voted');
    expect(authRepo.countConsumed(pollId)).toBe(1);
  });

  it('shows the roster and the config fingerprint on the ballot (US-11)', async () => {
    const { pollId, invites, configHash } = await makePoll();
    const ballot = await app.inject({ method: 'GET', url: `/v/${invites[0]!.token}` });
    expect(ballot.body).toContain('priya@example.com');
    expect(ballot.body).toContain(configHash.slice(0, 8));
    expect(pollId).toBeTruthy();
  });

  it('warns about the small-N problem on the ballot (§2.2)', async () => {
    const { invites } = await makePoll();
    const ballot = await app.inject({ method: 'GET', url: `/v/${invites[0]!.token}` });
    expect(ballot.body).toMatch(/unanimous result reveals everyone/);
  });

  it('rejects a vote whose CSRF token does not match the ballot render', async () => {
    const { pollId, invites } = await makePoll();
    const token = invites[0]!.token;
    const ballot = await app.inject({ method: 'GET', url: `/v/${token}` });

    const cast = await app.inject({
      method: 'POST',
      url: `/api/polls/${pollId}/vote`,
      headers: {
        cookie: jar(ballot.headers as Record<string, unknown>),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({ token, option_index: '0', csrf: 'not-the-right-value' }).toString(),
    });

    expect(cast.statusCode).toBe(403);
    expect(authRepo.countConsumed(pollId)).toBe(0);
  });

  it('returns 404 for an unknown token and never says why', async () => {
    const res = await app.inject({ method: 'GET', url: '/v/completely-made-up-token' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('That ballot does not exist');
  });

  it('returns 410 once the deadline has passed (FR-3.6)', async () => {
    const { pollId, invites } = await makePoll({ minutes: 20 });
    const ballot = await app.inject({ method: 'GET', url: `/v/${invites[0]!.token}` });
    const cookies = jar(ballot.headers as Record<string, unknown>);
    const csrf = hiddenField(ballot.body, 'csrf');

    // There is no API that moves a poll's deadline, so the test moves the clock
    // in the store directly.
    const { default: Database } = await import('better-sqlite3');
    const { config } = await import('../src/config.js');
    const path = await import('node:path');
    const handle = new Database(path.join(config.DATA_DIR, 'auth.sqlite'));
    handle
      .prepare('UPDATE polls SET closes_at = ? WHERE poll_id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), pollId);
    handle.close();

    const cast = await app.inject({
      method: 'POST',
      url: `/api/polls/${pollId}/vote`,
      headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        token: invites[0]!.token,
        option_index: '0',
        csrf,
      }).toString(),
    });

    expect(cast.statusCode).toBe(410);
    expect(authRepo.countConsumed(pollId)).toBe(0);
  });
});

describe('the typed code is the same ballot (FR-2.3)', () => {
  it('opens the ballot by code and consumes the link at the same time', async () => {
    const { pollId, invites } = await makePoll();
    const invite = invites[0]!;

    const entry = await app.inject({ method: 'GET', url: `/c/${pollId}` });
    expect(entry.statusCode).toBe(200);
    const cookies = jar(entry.headers as Record<string, unknown>);
    const csrf = hiddenField(entry.body, 'csrf');

    const verified = await app.inject({
      method: 'POST',
      url: `/api/polls/${pollId}/verify-code`,
      headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code: invite.code, csrf }).toString(),
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.body).toContain('Nothing is cast yet');
    // FR-2.4 — verifying a code consumes nothing.
    expect(authRepo.countConsumed(pollId)).toBe(0);

    const verifiedCookies = jar(verified.headers as Record<string, unknown>) || cookies;
    const cast = await app.inject({
      method: 'POST',
      url: `/api/polls/${pollId}/vote`,
      headers: { cookie: verifiedCookies, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        code: invite.code,
        option_index: '1',
        csrf: hiddenField(verified.body, 'csrf'),
      }).toString(),
    });
    expect(cast.statusCode).toBe(200);

    // The magic link for the same voter is now spent too — one ballot, two doors.
    expect(authRepo.getTokenByHash(hashToken(invite.token))?.consumed).toBe(true);
    expect(authRepo.countConsumed(pollId)).toBe(1);
  });

  it('rejects a wrong code without saying whether the poll exists', async () => {
    const { pollId } = await makePoll();
    const entry = await app.inject({ method: 'GET', url: `/c/${pollId}` });
    const cookies = jar(entry.headers as Record<string, unknown>);
    const csrf = hiddenField(entry.body, 'csrf');

    const res = await app.inject({
      method: 'POST',
      url: `/api/polls/${pollId}/verify-code`,
      headers: { cookie: cookies, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ code: 'ZZZZ-ZZZZ', csrf }).toString(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('doesn&#39;t match');
  });
});

describe('results are withheld until they are complete', () => {
  it('403s the results endpoint while the poll is open (FR-4.2)', async () => {
    const { pollId, invites } = await makePoll();
    await voteThroughTheUi(pollId, invites[0]!.token, 0);

    const res = await app.inject({ method: 'GET', url: `/api/polls/${pollId}/results` });
    expect(res.statusCode).toBe(403);
    expect(res.body).toBe('');
  });

  it('exposes turnout as a count with no roster, at all times (FR-4.1)', async () => {
    const { pollId, invites } = await makePoll();
    await voteThroughTheUi(pollId, invites[0]!.token, 0);

    const res = await app.inject({ method: 'GET', url: `/api/polls/${pollId}/turnout` });
    expect(res.json()).toEqual({ turnout: 1, total: 3, status: 'open' });
    expect(res.body).not.toMatch(/@/);

    const page = await app.inject({ method: 'GET', url: `/p/${pollId}` });
    expect(page.body).toContain('1 <span');
    expect(page.body).not.toContain('priya@example.com');
  });

  it('releases counts and the integrity verdict at 100% turnout (FR-4.3, FR-4.4)', async () => {
    const { pollId, invites } = await makePoll();
    for (const [i, invite] of invites.entries()) {
      await voteThroughTheUi(pollId, invite.token, i === 0 ? 1 : 0);
    }
    await flush();

    const res = await app.inject({ method: 'GET', url: `/api/polls/${pollId}/results` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      counts: [2, 1],
      total_ballots: 3,
      roster_size: 3,
      integrity: 'PASS',
    });

    const page = await app.inject({ method: 'GET', url: `/p/${pollId}` });
    expect(page.body).toContain('PASS');
    expect(page.body).toContain('Ballots counted');
  });

  it('shows failure with turnout but no numbers after the deadline (US-14)', async () => {
    const { pollId, invites } = await makePoll({ minutes: 20 });
    await voteThroughTheUi(pollId, invites[0]!.token, 0);

    const { default: Database } = await import('better-sqlite3');
    const { config } = await import('../src/config.js');
    const path = await import('node:path');
    const handle = new Database(path.join(config.DATA_DIR, 'auth.sqlite'));
    handle
      .prepare('UPDATE polls SET closes_at = ? WHERE poll_id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), pollId);
    handle.close();

    const page = await app.inject({ method: 'GET', url: `/p/${pollId}` });
    expect(page.body).toContain('Failed — no consensus');
    expect(page.body).toContain('1 <span'); // turnout reached, still shown
    const results = await app.inject({ method: 'GET', url: `/api/polls/${pollId}/results` });
    expect(results.statusCode).toBe(403);
  });
});

describe('response headers (§8)', () => {
  it('sets no-store, no-referrer, noindex and a script-free CSP on ballot pages', async () => {
    const { invites } = await makePoll();
    const res = await app.inject({ method: 'GET', url: `/v/${invites[0]!.token}` });
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, private');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'none'");
  });

  it('serves no JavaScript anywhere on the ballot page', async () => {
    const { invites } = await makePoll();
    const res = await app.inject({ method: 'GET', url: `/v/${invites[0]!.token}` });
    expect(res.body).not.toMatch(/<script/i);
    expect(res.body).not.toMatch(/\son[a-z]+=/i);
  });
});

describe('creator surface', () => {
  it('will not let an unauthenticated caller create a poll', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/polls',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ question: 'x' }).toString(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('gives the same answer whether or not an address may create polls', async () => {
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/auth/request-link',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: 'ravi@example.com' }).toString(),
    });
    resetRateLimits();
    const denied = await app.inject({
      method: 'POST',
      url: '/api/auth/request-link',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: 'stranger@example.com' }).toString(),
    });
    expect(allowed.statusCode).toBe(denied.statusCode);
    expect(allowed.body).toBe(denied.body);
  });

  it('rate limits the ballot endpoint (FR-3.7)', async () => {
    const { invites } = await makePoll();
    let limited = false;
    for (let i = 0; i < 14; i += 1) {
      const res = await app.inject({ method: 'GET', url: `/v/${invites[0]!.token}` });
      if (res.statusCode === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe('the webhook is signature-gated (FR-2.8)', () => {
  it('rejects an unsigned bounce callback', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/zeptomail',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ event_name: 'bounce', email_address: 'priya@example.com' }),
    });
    expect(res.statusCode).toBe(401);
  });
});
