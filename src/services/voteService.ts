import { log } from '../logging.js';
import { hashCode, hashToken, isWellFormedCode } from '../domain/crypto.js';
import * as authRepo from '../repos/authRepo.js';
import * as tallyRepo from '../repos/tallyRepo.js';
import { resultsReadyEmail } from '../email/templates.js';
import { sendEmail } from '../email/zeptomail.js';
import { evaluateDeadline } from './lifecycle.js';

/**
 * FR-2.3 — the magic link and the typed code are two ways of presenting the
 * same single ballot. Either one consumes it; there is no second ballot.
 */
export type Credential =
  | { kind: 'token'; token: string }
  | { kind: 'code'; pollId: string; code: string };

export function resolveCredential(cred: Credential): authRepo.BallotToken | null {
  if (cred.kind === 'token') {
    // Lookup is by SHA-256 of the presented token: the stored value is a hash,
    // so a miss reveals nothing about any real token (FR-2.1, FR-3.5).
    return authRepo.getTokenByHash(hashToken(cred.token));
  }
  if (!isWellFormedCode(cred.code)) return null;
  return authRepo.getTokenByCodeHash(cred.pollId, hashCode(cred.pollId, cred.code));
}

export type VoteResult =
  | { kind: 'ok'; turnout: number; voterCount: number; completed: boolean; pollId: string }
  | { kind: 'already_voted' } // 409
  | { kind: 'unknown' } // 404
  | { kind: 'closed'; status: authRepo.PollStatus; pollId: string } // 410
  | { kind: 'lost'; pollId: string }; // 500 — consumed but not tallied

/**
 * FR-3.2 — the whole privacy architecture is this function's ordering.
 *
 *   (a) consume the token in the AUTH store,
 *   (b) only then increment a counter in the TALLY store.
 *
 * Never the reverse. A crash between (a) and (b) loses a ballot, and the poll
 * fails at its deadline with results suppressed. The reverse ordering would
 * risk a double count, which is unrecoverable and silent. We fail closed.
 *
 * Nothing crosses the air gap except `poll_id` and `option_index` — neither is
 * voter-identifying, and neither is written anywhere alongside the other.
 */
export function castVote(cred: Credential, optionIndex: number): VoteResult {
  const token = resolveCredential(cred);
  if (!token) return { kind: 'unknown' };
  const tokenHash = token.tokenHash;

  const poll = authRepo.getPoll(token.pollId);
  if (!poll) return { kind: 'unknown' };

  // §11 — lazy deadline evaluation on every read. Never trust the timer alone.
  const evaluated = evaluateDeadline(poll);
  if (evaluated.status !== 'open' && evaluated.status !== 'at_risk') {
    return { kind: 'closed', status: evaluated.status, pollId: poll.pollId };
  }
  if (optionIndex < 0 || optionIndex >= poll.options.length) return { kind: 'unknown' };

  // (a) — atomic, conditional, and it re-checks the deadline against the
  // server clock inside the same transaction (§10, clock skew).
  const outcome = authRepo.consumeBallot(tokenHash, new Date().toISOString());
  if (outcome.kind === 'unknown_token') return { kind: 'unknown' };
  if (outcome.kind === 'already_consumed') return { kind: 'already_voted' };
  if (outcome.kind === 'closed') return { kind: 'closed', status: outcome.status, pollId: poll.pollId };

  // (b) — one UPDATE, no INSERT, no timestamp.
  let tallied = false;
  try {
    tallied = tallyRepo.incrementTally(poll.pollId, optionIndex);
  } catch {
    tallied = false;
  }

  if (!tallied) {
    // FR-3.3 — alert with poll_id only. Never the token, never the option.
    log.error('ballot consumed but not tallied; poll marked at_risk', { poll_id: poll.pollId });
    authRepo.markAtRisk(poll.pollId);
    return { kind: 'lost', pollId: poll.pollId };
  }

  if (outcome.completed) {
    // Read the roster synchronously, before FR-4.7 purges it on first render.
    const roster = authRepo.listRosterEmails(poll.pollId);
    const body = resultsReadyEmail({ question: poll.question, pollId: poll.pollId });
    void Promise.all(roster.map((email) => sendEmail(email, body))).catch(() => {
      log.warn('results notification failed', { poll_id: poll.pollId });
    });
  }

  return {
    kind: 'ok',
    turnout: outcome.turnout,
    voterCount: poll.voterCount,
    completed: outcome.completed,
    pollId: poll.pollId,
  };
}
