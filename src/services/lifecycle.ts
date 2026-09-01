import { log } from '../logging.js';
import { RETENTION_DAYS_AFTER_END } from '../domain/validation.js';
import * as authRepo from '../repos/authRepo.js';
import * as tallyRepo from '../repos/tallyRepo.js';
import { pollFailedEmail } from '../email/templates.js';
import { sendEmail } from '../email/zeptomail.js';
import { notifyPendingResults } from './notifications.js';

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

/** The instant a poll that ended at `finalizedAt` stops existing. */
export function retentionCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - RETENTION_DAYS_AFTER_END * 24 * 3600_000).toISOString();
}

/**
 * §6.4 — a poll is deleted outright 7 days after it ends, whether it
 * completed, failed or was cancelled. Question, options, roster, token
 * hashes, turnout and the counts all go; the URL 404s afterwards.
 *
 * Tallies first, then the auth row. A crash in between leaves a poll row that
 * the next sweep picks up again, rather than counters that nothing can reach.
 */
export function deletePollCompletely(pollId: string): void {
  tallyRepo.deleteTallies(pollId);
  authRepo.deletePoll(pollId);
  log.info('poll deleted at end of retention window', { poll_id: pollId });
}

/**
 * Returns the poll as it should be seen right now, or null if it should no
 * longer exist. Deadlines and the retention window are both enforced here, so
 * neither depends on the sweeper having run — a poll can never be read in a
 * state its own clock says it cannot be in.
 */
export function evaluateDeadline(poll: authRepo.Poll, now: Date = new Date()): authRepo.Poll | null {
  if (poll.finalizedAt && poll.finalizedAt < retentionCutoff(now)) {
    deletePollCompletely(poll.pollId);
    return null;
  }
  if (poll.status !== 'open' && poll.status !== 'at_risk') return poll;
  if (now.toISOString() < poll.closesAt) return poll;
  failPoll(poll);

  const failed = authRepo.getPoll(poll.pollId) ?? { ...poll, status: 'failed' as const };
  // A poll whose deadline passed more than the retention window ago (the
  // service was down for a long time) fails and is deleted in one pass.
  if (failed.finalizedAt && failed.finalizedAt < retentionCutoff(now)) {
    deletePollCompletely(poll.pollId);
    return null;
  }
  return failed;
}

export function loadPoll(pollId: string): authRepo.Poll | null {
  const poll = authRepo.getPoll(pollId);
  if (!poll) return null;
  return evaluateDeadline(poll);
}

/**
 * The 60-second interval half of §11: fails polls whose deadline has passed,
 * then deletes every poll that ended more than the retention window ago.
 */
export function sweepExpiredPolls(now: Date = new Date()): {
  failed: number;
  deleted: number;
  announced: number;
} {
  const expired = authRepo.listExpiredOpenPolls(now.toISOString());
  for (const poll of expired) failPoll(poll);

  // A poll that completed while the process was dying still owes its voters an
  // announcement. Delayed by a restart, never lost to one.
  const announced = notifyPendingResults();

  // §6.4 — 7 days after a poll ends, the poll and its results are deleted.
  const doomed = authRepo.listPollsPastRetention(retentionCutoff(now));
  for (const pollId of doomed) deletePollCompletely(pollId);

  return { failed: expired.length, deleted: doomed.length, announced };
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
