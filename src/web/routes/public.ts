import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyCodeSchema, voteSchema } from '../../domain/validation.js';
import { getPollView, type PollView } from '../../services/resultsService.js';
import { castVote, resolveCredential, type Credential } from '../../services/voteService.js';
import { STYLESHEET } from '../views/layout.js';
import { ballotPage, codeEntryPage, confirmPage, messagePage, pollPage, votedPage } from '../views/pages.js';
import { allow, codeAttemptAllowed, recordCodeFailure } from '../rateLimit.js';
import { checkCsrf, issueCsrf } from '../csrf.js';
import * as authRepo from '../../repos/authRepo.js';

/**
 * Voter-facing routes. Nothing here requires an account, and nothing here can
 * return a roster of who voted.
 */

function html(reply: FastifyReply, code: number, body: string): FastifyReply {
  return reply.code(code).type('text/html; charset=utf-8').send(body);
}

function wantsJson(req: FastifyRequest): boolean {
  return (req.headers.accept ?? '').includes('application/json');
}

function tooMany(reply: FastifyReply): FastifyReply {
  return html(
    reply,
    429,
    messagePage({
      title: 'Slow down',
      heading: 'Too many requests',
      body: 'Give it a minute and try again.',
    }),
  );
}

function notFoundBallot(reply: FastifyReply): FastifyReply {
  // FR-3.5 — generic, identical for "never existed" and "wrong poll".
  return html(
    reply,
    404,
    messagePage({
      title: 'Not found',
      heading: 'That ballot does not exist',
      body: 'The link or code is not valid. Check the invite email you were sent.',
      tone: 'bad',
    }),
  );
}

function closedNotice(reply: FastifyReply, view: PollView): FastifyReply {
  const body =
    view.status === 'cancelled'
      ? 'This poll was cancelled. Any votes cast were deleted without being counted.'
      : view.status === 'completed'
        ? 'Everyone has already voted and this poll is closed.'
        : 'The deadline passed before everyone voted, so this poll failed. No counts exist.';
  return html(
    reply,
    410,
    messagePage({
      title: 'Poll closed',
      heading: 'This poll is closed',
      body,
      tone: 'bad',
      link: { href: `/p/${view.pollId}`, label: 'See the poll' },
    }),
  );
}

function alreadyVoted(reply: FastifyReply, pollId: string): FastifyReply {
  // FR-3.4 / US-10 — plain language, not an error dump.
  return html(
    reply,
    409,
    messagePage({
      title: 'Already voted',
      heading: "You've already voted",
      body: 'Your ballot was used, which means it counted. One vote each, and Voto cannot tell you which one was yours.',
      tone: 'good',
      link: { href: `/p/${pollId}`, label: 'See turnout' },
    }),
  );
}

/** Renders a ballot from a credential without touching it (FR-2.4). */
function renderBallot(
  req: FastifyRequest,
  reply: FastifyReply,
  cred: Credential,
  hidden: Record<string, string>,
): FastifyReply {
  const token = resolveCredential(cred);
  if (!token) return notFoundBallot(reply);

  const view = getPollView(token.pollId);
  if (!view) return notFoundBallot(reply);
  if (view.status !== 'open' && view.status !== 'at_risk') return closedNotice(reply, view);
  if (token.consumed) return alreadyVoted(reply, view.pollId);

  const csrf = issueCsrf(reply);
  const roster = authRepo.listRosterEmails(view.pollId);
  return html(
    reply,
    200,
    ballotPage({
      view,
      roster,
      csrf,
      action: `/api/polls/${view.pollId}/confirm`,
      hidden,
    }),
  );
}

function credentialFrom(body: Record<string, unknown>, pollId: string): Credential | null {
  const token = typeof body.token === 'string' ? body.token : '';
  const code = typeof body.code === 'string' ? body.code : '';
  if (token) return { kind: 'token', token };
  if (code) return { kind: 'code', pollId, code };
  return null;
}

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  app.get('/static/app.css', async (_req, reply) =>
    reply.type('text/css; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(STYLESHEET),
  );

  app.get('/healthz', async (_req, reply) => reply.send({ ok: true }));

  /** §8 — public status page. Results only if completed (FR-4.2). */
  app.get<{ Params: { poll_id: string } }>('/p/:poll_id', async (req, reply) => {
    const view = getPollView(req.params.poll_id);
    if (!view) return notFoundBallot(reply);
    return html(reply, 200, pollPage(view));
  });

  /** FR-2.4 — GET validates and renders. It never mutates anything. */
  app.get<{ Params: { token: string } }>('/v/:token', async (req, reply) => {
    if (!allow({ ip: req.ip, scope: 'ballot' })) return tooMany(reply);
    return renderBallot(req, reply, { kind: 'token', token: req.params.token }, {
      token: req.params.token,
    });
  });

  /** US-6 — the same ballot, reached by typing a code instead. */
  app.get<{ Params: { poll_id: string } }>('/c/:poll_id', async (req, reply) => {
    if (!allow({ ip: req.ip, scope: 'ballot', pollId: req.params.poll_id })) return tooMany(reply);
    const view = getPollView(req.params.poll_id);
    if (!view) return notFoundBallot(reply);
    if (view.status !== 'open' && view.status !== 'at_risk') return closedNotice(reply, view);
    const csrf = issueCsrf(reply);
    return html(reply, 200, codeEntryPage({ pollId: view.pollId, question: view.question, csrf }));
  });

  /** Exchanges a code for a ballot render. Does not consume (FR-2.4). */
  app.post<{ Params: { poll_id: string } }>('/api/polls/:poll_id/verify-code', async (req, reply) => {
    const pollId = req.params.poll_id;
    if (!allow({ ip: req.ip, scope: 'code', pollId })) return tooMany(reply);

    const parsed = verifyCodeSchema.safeParse(req.body ?? {});
    if (!parsed.success) return notFoundBallot(reply);
    if (!checkCsrf(req, parsed.data.csrf)) return notFoundBallot(reply);

    const view = getPollView(pollId);
    if (!view) return notFoundBallot(reply);
    if (view.status !== 'open' && view.status !== 'at_risk') return closedNotice(reply, view);

    // FR-2.2 — five wrong codes per poll per client, then it stops.
    if (!codeAttemptAllowed(pollId, req.ip)) {
      return html(
        reply,
        429,
        codeEntryPage({
          pollId,
          question: view.question,
          csrf: issueCsrf(reply),
          error: 'Too many wrong codes. Try again in an hour, or use the link in your email.',
        }),
      );
    }

    const cred: Credential = { kind: 'code', pollId, code: parsed.data.code };
    const token = resolveCredential(cred);
    if (!token) {
      recordCodeFailure(pollId, req.ip);
      return html(
        reply,
        404,
        codeEntryPage({
          pollId,
          question: view.question,
          csrf: issueCsrf(reply),
          error: "That code doesn't match. Check it against your invite email.",
        }),
      );
    }
    if (token.consumed) return alreadyVoted(reply, pollId);

    return renderBallot(req, reply, cred, { code: parsed.data.code });
  });

  /** US-8 — the explicit second tap. Still consumes nothing. */
  app.post<{ Params: { poll_id: string } }>('/api/polls/:poll_id/confirm', async (req, reply) => {
    const pollId = req.params.poll_id;
    if (!allow({ ip: req.ip, scope: 'ballot', pollId })) return tooMany(reply);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const cred = credentialFrom(body, pollId);
    const csrf = typeof body.csrf === 'string' ? body.csrf : undefined;
    const optionIndex = Number(body.option_index);
    if (!cred || !checkCsrf(req, csrf) || !Number.isInteger(optionIndex)) return notFoundBallot(reply);

    const token = resolveCredential(cred);
    if (!token) return notFoundBallot(reply);

    const view = getPollView(token.pollId);
    if (!view) return notFoundBallot(reply);
    if (view.status !== 'open' && view.status !== 'at_risk') return closedNotice(reply, view);
    if (token.consumed) return alreadyVoted(reply, view.pollId);
    if (optionIndex < 0 || optionIndex >= view.options.length) return notFoundBallot(reply);

    const nextCsrf = issueCsrf(reply);
    const hidden: Record<string, string> =
      cred.kind === 'token' ? { token: cred.token } : { code: cred.code };
    return html(
      reply,
      200,
      confirmPage({
        view,
        optionIndex,
        csrf: nextCsrf,
        action: `/api/polls/${view.pollId}/vote`,
        hidden,
      }),
    );
  });

  /** FR-3.1 / FR-3.2 — the only endpoint that consumes a ballot. */
  app.post<{ Params: { poll_id: string } }>('/api/polls/:poll_id/vote', async (req, reply) => {
    const pollId = req.params.poll_id;
    if (!allow({ ip: req.ip, scope: 'vote', pollId })) return tooMany(reply);

    const body = (req.body ?? {}) as Record<string, unknown>;
    const cred = credentialFrom(body, pollId);
    const parsed = voteSchema
      .omit({ token: true })
      .safeParse({ option_index: body.option_index, csrf: body.csrf });
    if (!cred || !parsed.success) return notFoundBallot(reply);
    if (!checkCsrf(req, parsed.data.csrf)) {
      return html(
        reply,
        403,
        messagePage({
          title: 'Expired',
          heading: 'That ballot page expired',
          body: 'Open your link again and re-submit. Nothing was cast.',
          tone: 'warn',
        }),
      );
    }

    const result = castVote(cred, parsed.data.option_index);

    switch (result.kind) {
      case 'unknown':
        return wantsJson(req) ? reply.code(404).send({ error: 'not_found' }) : notFoundBallot(reply);
      case 'already_voted':
        return wantsJson(req)
          ? reply.code(409).send({ error: 'already_voted' })
          : alreadyVoted(reply, pollId);
      case 'closed': {
        const view = getPollView(pollId);
        if (wantsJson(req)) return reply.code(410).send({ error: 'closed', status: result.status });
        return view
          ? closedNotice(reply, view)
          : html(
              reply,
              410,
              messagePage({ title: 'Closed', heading: 'This poll is closed', body: '', tone: 'bad' }),
            );
      }
      case 'lost':
        // FR-3.3 — the voter is told the truth: their ballot did not land.
        return html(
          reply,
          500,
          messagePage({
            title: 'Ballot not recorded',
            heading: 'Your ballot could not be recorded',
            body: 'Voto could not store your vote, and it will not risk counting it twice. This poll is now marked at risk and will fail at its deadline. Nobody will see any numbers.',
            tone: 'bad',
            link: { href: `/p/${pollId}`, label: 'See the poll' },
          }),
        );
      case 'ok': {
        if (wantsJson(req)) {
          return reply.code(200).send({ turnout: result.turnout, total: result.voterCount });
        }
        const view = getPollView(pollId);
        if (!view) return notFoundBallot(reply);
        return html(reply, 200, votedPage({ view, completed: result.completed }));
      }
    }
  });

  /** FR-4.2 — 403 with no payload until the poll is completed. */
  app.get<{ Params: { poll_id: string } }>('/api/polls/:poll_id/results', async (req, reply) => {
    const view = getPollView(req.params.poll_id);
    if (!view) return reply.code(404).send({ error: 'not_found' });
    if (view.status !== 'completed' || !view.results) return reply.code(403).send();
    return reply.code(200).send({
      counts: view.results.counts,
      total_ballots: view.results.totalBallots,
      roster_size: view.results.rosterSize,
      integrity: view.results.integrity,
      config_hash: view.configHash,
    });
  });

  /** FR-4.1 — turnout, as a count, to anyone with the poll id. */
  app.get<{ Params: { poll_id: string } }>('/api/polls/:poll_id/turnout', async (req, reply) => {
    const view = getPollView(req.params.poll_id);
    if (!view) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ turnout: view.turnout, total: view.voterCount, status: view.status });
  });
}
