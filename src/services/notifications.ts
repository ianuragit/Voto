import { log } from '../logging.js';
import { RETENTION_DAYS_AFTER_END } from '../domain/validation.js';
import { summarise } from '../domain/results.js';
import * as authRepo from '../repos/authRepo.js';
import * as tallyRepo from '../repos/tallyRepo.js';
import { pollResultsEmail, resultsWithheldEmail } from '../email/templates.js';
import { sendEmail } from '../email/mailer.js';

/**
 * Telling everyone how it ended.
 *
 * This module deliberately does not import `lifecycle` or `resultsService`:
 * the sweeper calls into here, so a dependency the other way would be a cycle.
 * The integrity verdict comes from `domain/results`, which is pure, so the
 * email and the results page cannot drift apart.
 */

/**
 * Mails every voter the final counts and the total ballot count.
 *
 * Three things make this safe to call from either the vote path or the
 * sweeper:
 *
 *   - The send is *claimed* first, with an atomic UPDATE. Exactly one caller
 *     wins, so the founding team never receives the result twice.
 *   - The roster is read before anything can render the results page, because
 *     that render purges the addresses (FR-4.7). The purge itself now waits
 *     for this claim, so a poll can always still be announced.
 *   - It never throws. The ballot is already counted and the results page is
 *     authoritative; a mail failure must not fail a vote.
 */
export function notifyResults(poll: authRepo.Poll, turnout: number): boolean {
  try {
    if (!authRepo.claimResultsNotification(poll.pollId)) return false;

    const roster = authRepo.listRosterEmails(poll.pollId);
    const results = summarise(tallyRepo.readTallies(poll.pollId), turnout, poll.voterCount);
    const finalizedAt = authRepo.getPoll(poll.pollId)?.finalizedAt ?? poll.finalizedAt;

    // FR-4.5 — a result that does not reconcile is withheld from the email
    // exactly as it is withheld from the page.
    const body =
      results.integrity === 'PASS'
        ? pollResultsEmail({
            question: poll.question,
            options: poll.options,
            pollId: poll.pollId,
            counts: results.counts,
            totalBallots: results.totalBallots,
            rosterSize: results.rosterSize,
            deletesAt: finalizedAt
              ? new Date(
                  new Date(finalizedAt).getTime() + RETENTION_DAYS_AFTER_END * 24 * 3600_000,
                ).toISOString()
              : null,
          })
        : resultsWithheldEmail({
            question: poll.question,
            pollId: poll.pollId,
            discrepancy: results.discrepancy ?? 'The count did not reconcile.',
          });

    void Promise.all(roster.map((email) => sendEmail(email, body))).catch(() => {
      log.warn('results notification failed', { poll_id: poll.pollId });
    });
    return true;
  } catch {
    log.warn('could not send results notification', { poll_id: poll.pollId });
    return false;
  }
}

/**
 * Finishes the job for any poll that completed while the process was dying:
 * status is `completed`, but nobody was ever told. Runs on every sweep and at
 * boot, so an announcement is delayed by a restart, never lost to one.
 */
export function notifyPendingResults(): number {
  let sent = 0;
  for (const poll of authRepo.listAwaitingResultsNotification()) {
    if (notifyResults(poll, authRepo.countConsumed(poll.pollId))) {
      log.info('sent a results notification that a restart had interrupted', {
        poll_id: poll.pollId,
      });
      sent += 1;
    }
  }
  return sent;
}
