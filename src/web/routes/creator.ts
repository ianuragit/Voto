import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { log } from '../../logging.js';
import { checkboxOn, isEmail } from '../../domain/validation.js';
import * as authRepo from '../../repos/authRepo.js';
import { getPollView } from '../../services/resultsService.js';
import {
  cancelPoll,
  correctRoster,
  createPoll,
  creatorIsAllowed,
  resendInvites,
} from '../../services/pollService.js';
import { creatorSignInEmail } from '../../email/templates.js';
import { sendEmail } from '../../email/mailer.js';
import { checkCsrf, issueCsrf } from '../csrf.js';
import { allow } from '../rateLimit.js';
import { clearSession, currentCreator, mintSignInToken, redeemSignInToken, setSession } from '../session.js';
import { consolePollPage, createFormPage, messagePage, signInPage } from '../views/pages.js';

function html(reply: FastifyReply, code: number, body: string): FastifyReply {
  return reply.code(code).type('text/html; charset=utf-8').send(body);
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') return [value];
  return [];
}

function requireCreator(req: FastifyRequest, reply: FastifyReply): string | null {
  const email = currentCreator(req);
  if (!email) {
    html(reply, 401, signInPage({ error: 'Sign in first.' }));
    return null;
  }
  return email;
}

export async function creatorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', async (req, reply) => {
    const creator = currentCreator(req);
    if (!creator) return html(reply, 200, signInPage({}));
    const csrf = issueCsrf(reply);
    return html(
      reply,
      200,
      createFormPage({ creatorEmail: creator, csrf, polls: authRepo.listPollsByCreator(creator) }),
    );
  });

  /**
   * §8 — magic-link console sign-in against the ALLOWED_CREATORS env
   * allowlist. The response is identical whether or not the address is
   * allowed, so this is not an allowlist oracle.
   */
  app.post('/api/auth/request-link', async (req, reply) => {
    if (!allow({ ip: req.ip, scope: 'signin' })) {
      return html(reply, 429, signInPage({ error: 'Too many attempts. Wait a minute.' }));
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!isEmail(email)) return html(reply, 400, signInPage({ error: 'That address is not valid.' }));

    if (creatorIsAllowed(email)) {
      const link = `${config.PUBLIC_BASE_URL}/auth/callback?t=${encodeURIComponent(mintSignInToken(email))}`;
      void sendEmail(email, creatorSignInEmail({ link }));
    }
    return html(reply, 200, signInPage({ sent: true }));
  });

  app.get<{ Querystring: { t?: string } }>('/auth/callback', async (req, reply) => {
    const token = req.query.t ?? '';
    const email = token ? redeemSignInToken(token) : null;
    if (!email || !creatorIsAllowed(email)) {
      return html(reply, 401, signInPage({ error: 'That sign-in link is expired or not valid.' }));
    }
    setSession(reply, email);
    return reply.redirect('/', 303);
  });

  app.post('/api/auth/signout', async (_req, reply) => {
    clearSession(reply);
    return reply.redirect('/', 303);
  });

  /** §5.1 / FR-1.6 — create the poll and send the invites. */
  app.post('/api/polls', async (req, reply) => {
    const creator = requireCreator(req, reply);
    if (!creator) return reply;

    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!checkCsrf(req, typeof body.csrf === 'string' ? body.csrf : undefined)) {
      return html(reply, 403, signInPage({ error: 'That form expired. Try again.' }));
    }

    const result = createPoll({
      question: String(body.question ?? ''),
      rawOptions: asArray(body.options),
      rawVoters: String(body.voters ?? ''),
      rawDurationDays: body.duration_days,
      creatorEmail: creator,
      creatorVotes: checkboxOn(body.creator_votes),
      allowAbstain: checkboxOn(body.allow_abstain),
    });

    if (!result.ok) {
      const csrf = issueCsrf(reply);
      return html(
        reply,
        400,
        createFormPage({
          creatorEmail: creator,
          csrf,
          error: result.error,
          polls: authRepo.listPollsByCreator(creator),
        }),
      );
    }

    if ((req.headers.accept ?? '').includes('application/json')) {
      return reply.code(201).send({ poll_id: result.pollId, config_hash: result.configHash });
    }
    return reply.redirect(`/console/${result.pollId}?created=1`, 303);
  });

  app.get<{ Params: { poll_id: string }; Querystring: Record<string, string> }>(
    '/console/:poll_id',
    async (req, reply) => {
      const creator = requireCreator(req, reply);
      if (!creator) return reply;

      const poll = authRepo.getPoll(req.params.poll_id);
      if (!poll || poll.creatorEmail !== creator) {
        return html(
          reply,
          404,
          messagePage({ title: 'Not found', heading: 'No such poll', body: '', tone: 'bad' }),
        );
      }
      const view = getPollView(poll.pollId);
      if (!view) {
        return html(
          reply,
          404,
          messagePage({ title: 'Not found', heading: 'No such poll', body: '', tone: 'bad' }),
        );
      }

      const messages: Record<string, string> = {
        created: 'Poll created. Invites are on their way.',
        resent: 'Invites resent to everyone on the roster.',
        roster: 'Address replaced. Everyone has been re-invited with the new fingerprint.',
        cancelled: 'Poll cancelled. All counts destroyed.',
      };
      const key = Object.keys(messages).find((k) => req.query[k] === '1');

      return html(
        reply,
        200,
        consolePollPage({
          view,
          delivery: authRepo.listDeliveryStatuses(poll.pollId),
          csrf: issueCsrf(reply),
          ...(key ? { message: messages[key] } : {}),
          ...(req.query.error ? { error: req.query.error } : {}),
        }),
      );
    },
  );

  const guarded = (
    action: (pollId: string, creator: string, body: Record<string, unknown>) =>
      | { ok: true }
      | { ok: false; status: number; error: string },
    redirectFlag: string,
  ) =>
    async (req: FastifyRequest<{ Params: { poll_id: string } }>, reply: FastifyReply) => {
      const creator = requireCreator(req, reply);
      if (!creator) return reply;
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!checkCsrf(req, typeof body.csrf === 'string' ? body.csrf : undefined)) {
        return reply.code(403).send({ error: 'csrf' });
      }
      const result = action(req.params.poll_id, creator, body);
      if (!result.ok) {
        if ((req.headers.accept ?? '').includes('application/json')) {
          return reply.code(result.status).send({ error: result.error });
        }
        return reply.redirect(
          `/console/${req.params.poll_id}?error=${encodeURIComponent(result.error)}`,
          303,
        );
      }
      if ((req.headers.accept ?? '').includes('application/json')) return reply.code(200).send({ ok: true });
      return reply.redirect(`/console/${req.params.poll_id}?${redirectFlag}=1`, 303);
    };

  app.post<{ Params: { poll_id: string } }>(
    '/api/polls/:poll_id/resend',
    guarded((pollId, creator) => resendInvites(pollId, creator), 'resent'),
  );

  app.patch<{ Params: { poll_id: string } }>(
    '/api/polls/:poll_id/roster',
    guarded(
      (pollId, creator, body) =>
        correctRoster(pollId, creator, String(body.old_email ?? ''), String(body.new_email ?? '')),
      'roster',
    ),
  );

  // Browsers cannot send PATCH from a form; the console posts here instead.
  app.post<{ Params: { poll_id: string } }>(
    '/api/polls/:poll_id/roster',
    guarded(
      (pollId, creator, body) =>
        correctRoster(pollId, creator, String(body.old_email ?? ''), String(body.new_email ?? '')),
      'roster',
    ),
  );

  app.post<{ Params: { poll_id: string } }>(
    '/api/polls/:poll_id/cancel',
    guarded((pollId, creator) => {
      const res = cancelPoll(pollId, creator);
      if (res.ok) log.info('cancel requested', { poll_id: pollId });
      return res;
    }, 'cancelled'),
  );
}
