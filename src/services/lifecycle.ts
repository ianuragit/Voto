import { log } from '../logging.js';
import * as authRepo from '../repos/authRepo.js';
import * as tallyRepo from '../repos/tallyRepo.js';
import { pollFailedEmail } from '../email/templates.js';
import { sendEmail } from '../email/zeptomail.js';

/**
 * §11 — deadline handling exists twice: a 60-second sweeper AND lazy
 * evaluation on every read. Both paths must exist; a poll must never be
 * readable in a state its deadline says it cannot be in.
 */

/** FR-4.6 — the deadline passed with someone missing. Fail closed, delete the counts. */
export function failPoll(poll: authRepo.Poll): void {
  const turnout = authRepo.countConsumed(poll.pollId);
  const roster = authRepo.listRosterEmails(poll.pollId);

  authRepo.setStatus(poll.pollId, 'failed');
  tallyRepo.deleteTallies(poll.pollId); // partial counts must be unrecoverable
  authRepo.purgeEmails(poll.pollId);

  log.info('poll failed at deadline', { poll_id: poll.pollId });

  const body = pollFailedEmail({
    question: poll.question,
    pollId: poll.pollId,
    turnout,
    voterCount: poll.voterCount,
  });
  void Promise.all(roster.map((email) => sendEmail(email, body))).catch(() => {
    log.warn('failure notification failed', { poll_id: poll.pollId });
  });
}

/**
 * Returns the poll as it should be seen right now. If its deadline has passed
 * while it was still open, it fails here — before any caller can act on a
 * stale status.
 */
export function evaluateDeadline(poll: authRepo.Poll, now: Date = new Date()): authRepo.Poll {
  if (poll.status !== 'open' && poll.status !== 'at_risk') return poll;
  if (now.toISOString() < poll.closesAt) return poll;
  failPoll(poll);
  return authRepo.getPoll(poll.pollId) ?? { ...poll, status: 'failed' };
}

export function loadPoll(pollId: string): authRepo.Poll | null {
  const poll = authRepo.getPoll(pollId);
  if (!poll) return null;
  return evaluateDeadline(poll);
}

/** The 60-second interval half of §11. Also purges tokens past their retention. */
export function sweepExpiredPolls(now: Date = new Date()): number {
  const expired = authRepo.listExpiredOpenPolls(now.toISOString());
  for (const poll of expired) failPoll(poll);

  // §6.4 — token hashes live 30 days past finalisation, then go.
  const cutoff = new Date(now.getTime() - 30 * 24 * 3600_000).toISOString();
  const purged = authRepo.purgeExpiredTokens(cutoff);
  if (purged > 0) log.info('purged expired token records', { polls: purged });

  return expired.length;
}

export function startSweeper(intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      sweepExpiredPolls();
    } catch (err) {
      log.error('deadline sweep failed', { reason: err instanceof Error ? err.name : 'unknown' });
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
