import { RETENTION_DAYS_AFTER_END } from '../domain/validation.js';
import * as authRepo from '../repos/authRepo.js';
import * as tallyRepo from '../repos/tallyRepo.js';
import { loadPoll } from './lifecycle.js';

export type Integrity = 'PASS' | 'INVALID';

export interface Results {
  counts: number[];
  totalBallots: number;
  rosterSize: number;
  integrity: Integrity;
  discrepancy: string | null;
}

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

function turnoutOf(poll: authRepo.Poll): number {
  // Ballots live exactly as long as their poll does (§6.4), so the live count
  // is always available while the poll is readable at all.
  return authRepo.countConsumed(poll.pollId);
}

/**
 * FR-4.5 — the audit. Results are released only when the counter total, the
 * number of consumed ballots and the roster size all agree. Any disagreement
 * suppresses the numbers entirely; it is not a warning printed next to them.
 */
function computeResults(poll: authRepo.Poll, turnout: number): Results {
  const counts = tallyRepo.readTallies(poll.pollId);
  const sum = counts.reduce((a, b) => a + b, 0);
  const pass = sum === turnout && turnout === poll.voterCount;
  if (pass) {
    return {
      counts,
      totalBallots: sum,
      rosterSize: poll.voterCount,
      integrity: 'PASS',
      discrepancy: null,
    };
  }
  return {
    counts: [], // suppressed
    totalBallots: sum,
    rosterSize: poll.voterCount,
    integrity: 'INVALID',
    discrepancy: `Counted ballots: ${sum}. Ballots consumed: ${turnout}. Roster size: ${poll.voterCount}. These must be equal, so the result is withheld.`,
  };
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
    deletesAt: poll.finalizedAt
      ? new Date(
          new Date(poll.finalizedAt).getTime() + RETENTION_DAYS_AFTER_END * 24 * 3600_000,
        ).toISOString()
      : null,
    results: null,
  };

  if (poll.status !== 'completed') return view; // FR-4.2 — no tally read at all

  view.results = computeResults(poll, turnout);

  // FR-4.7 — the poll is over and has been shown. The addresses go.
  if (!poll.emailsPurged) authRepo.purgeEmails(poll.pollId);

  return view;
}
