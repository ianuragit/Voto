import { RETENTION_DAYS_AFTER_END } from '../domain/validation.js';
import { summarise, type Results } from '../domain/results.js';
import * as authRepo from '../repos/authRepo.js';
import * as tallyRepo from '../repos/tallyRepo.js';
import { loadPoll } from './lifecycle.js';

export type { Integrity, Results } from '../domain/results.js';

export interface PollView {
  pollId: string;
  question: string;
  options: string[];
  status: authRepo.PollStatus;
  closesAt: string;
  createdAt: string;
  configHash: string;
  voterCount: number;
  turnout: number;
  /** §6.4 — when this poll and everything it produced are deleted. */
  deletesAt: string | null;
  /** FR-4.2 — present only when the poll is completed. */
  results: Results | null;
}

/** §6.4 — when this poll and everything it produced are deleted. */
export function deletionDateOf(poll: authRepo.Poll): string | null {
  if (!poll.finalizedAt) return null;
  return new Date(
    new Date(poll.finalizedAt).getTime() + RETENTION_DAYS_AFTER_END * 24 * 3600_000,
  ).toISOString();
}

function turnoutOf(poll: authRepo.Poll): number {
  // Ballots live exactly as long as their poll does (§6.4), so the live count
  // is always available while the poll is readable at all.
  return authRepo.countConsumed(poll.pollId);
}

/** FR-4.5 — the audit, delegated to the pure rule in `domain/results`. */
function computeResults(poll: authRepo.Poll, turnout: number): Results {
  return summarise(tallyRepo.readTallies(poll.pollId), turnout, poll.voterCount);
}

/**
 * The single read path for a poll. FR-4.1 — turnout is always a count and
 * never a roster; there is no variant of this function that returns names.
 */
export function getPollView(pollId: string): PollView | null {
  const poll = loadPoll(pollId);
  if (!poll) return null;

  const turnout = turnoutOf(poll);
  const view: PollView = {
    pollId: poll.pollId,
    question: poll.question,
    options: poll.options,
    status: poll.status,
    closesAt: poll.closesAt,
    createdAt: poll.createdAt,
    configHash: poll.configHash,
    voterCount: poll.voterCount,
    turnout,
    deletesAt: deletionDateOf(poll),
    results: null,
  };

  if (poll.status !== 'completed') return view; // FR-4.2 — no tally read at all

  view.results = computeResults(poll, turnout);

  // FR-4.7 — the poll is over and has been shown, so the addresses go. The one
  // thing they are still needed for is the results email, so the purge waits
  // for that to be claimed; otherwise a fast reader could delete the roster
  // before anyone had been told the outcome.
  if (!poll.emailsPurged && poll.resultsNotified) authRepo.purgeEmails(poll.pollId);

  return view;
}
