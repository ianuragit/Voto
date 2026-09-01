import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { config } from '../src/config.js';
import * as authRepo from '../src/repos/authRepo.js';
import * as tallyRepo from '../src/repos/tallyRepo.js';
import { castVote } from '../src/services/voteService.js';
import { getPollView } from '../src/services/resultsService.js';
import { sweepExpiredPolls } from '../src/services/lifecycle.js';
import { cancelPoll, createPoll } from '../src/services/pollService.js';
import { ALLOWED_DURATION_DAYS, RETENTION_DAYS_AFTER_END } from '../src/domain/validation.js';
import { hashToken } from '../src/domain/crypto.js';
import {
  DAY_MS,
  clearMail,
  flush,
  installCapturingTransport,
  makePoll,
  rewindClock,
  sentMail,
} from './helpers.js';

/**
 * Appendix A — the acceptance criteria for the privacy guarantee. Each test
 * below is one checkbox from that list.
 */

beforeEach(() => {
  installCapturingTransport();
  clearMail();
});

describe('Appendix A — schema review', () => {
  it('tally.sqlite holds nothing but poll_id, option_index and count', async () => {
    await makePoll();
    const db = new Database(path.join(config.DATA_DIR, 'tally.sqlite'), { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(['tallies']);

    const columns = db.prepare('PRAGMA table_info(tallies)').all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual(['poll_id', 'option_index', 'count']);
    db.close();
  });

  it('the two stores share no key beyond poll_id', async () => {
    const { pollId, invites } = await makePoll();
    castVote({ kind: 'token', token: invites[0]!.token }, 0);

    const auth = new Database(path.join(config.DATA_DIR, 'auth.sqlite'), { readonly: true });
    const tally = new Database(path.join(config.DATA_DIR, 'tally.sqlite'), { readonly: true });

    const authColumns = new Set<string>();
    for (const table of ['polls', 'ballot_tokens']) {
      for (const c of auth.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]) {
        authColumns.add(c.name);
      }
    }
    const tallyColumns = (tally.prepare('PRAGMA table_info(tallies)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    const shared = tallyColumns.filter((c) => authColumns.has(c));
    expect(shared).toEqual(['poll_id']);

    // And nothing in the tally store records when or in what order anything happened.
    const rows = tally.prepare('SELECT * FROM tallies WHERE poll_id = ?').all(pollId);
    expect(rows.length).toBe(2);
    expect(JSON.stringify(rows)).not.toMatch(/@|20\d\d-/);

    // FR-2.1 / §6.2.5 — the auth store holds no usable token.
    const tokenRows = auth
      .prepare('SELECT token_hash, code_hash FROM ballot_tokens WHERE poll_id = ?')
      .all(pollId) as { token_hash: string; code_hash: string }[];
    for (const row of tokenRows) {
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(tokenRows.map((r) => r.token_hash)).toContain(hashToken(invites[0]!.token));

    auth.close();
    tally.close();
  });

  it('an operator holding both files mid-poll cannot attribute a single vote', async () => {
    const { pollId, invites } = await makePoll({ rawOptions: ['Yes', 'No'] });
    castVote({ kind: 'token', token: invites[0]!.token }, 0);
    castVote({ kind: 'token', token: invites[1]!.token }, 1);

    const auth = new Database(path.join(config.DATA_DIR, 'auth.sqlite'), { readonly: true });
    const tally = new Database(path.join(config.DATA_DIR, 'tally.sqlite'), { readonly: true });

    // Everything the dump can say about who voted:
    const consumed = auth
      .prepare('SELECT email, consumed FROM ballot_tokens WHERE poll_id = ? AND consumed = 1')
      .all(pollId) as { email: string }[];
    expect(consumed.length).toBe(2);

    // ...and everything it can say about what was voted:
    const counts = tally.prepare('SELECT option_index, count FROM tallies WHERE poll_id = ?').all(
      pollId,
    ) as { option_index: number; count: number }[];
    expect(counts.map((c) => c.count).sort()).toEqual([1, 1]);

    // There is no column, in either file, that connects the two sets.
    const rowText = JSON.stringify(counts);
    for (const row of consumed) expect(rowText).not.toContain(row.email);

    auth.close();
    tally.close();
  });
});

describe('Appendix A — static analysis', () => {
  it('no module imports both database connections', () => {
    const out = execFileSync('node', ['scripts/check-air-gap.mjs'], { encoding: 'utf8' });
    expect(out).toMatch(/Air-gap check passed/);
  });
});

describe('Appendix A — GET never consumes (FR-2.4)', () => {
  it('resolving a magic link 50 times leaves consumed = 0', async () => {
    const { pollId, invites } = await makePoll();
    const token = invites[0]!.token;
    for (let i = 0; i < 50; i += 1) {
      const resolved = authRepo.getTokenByHash(hashToken(token));
      expect(resolved?.consumed).toBe(false);
      getPollView(pollId);
    }
    expect(authRepo.countConsumed(pollId)).toBe(0);
    expect(tallyRepo.sumTallies(pollId)).toBe(0);
  });
});

describe('Appendix A — a poll that expires short of 100% leaves no tallies (FR-4.6)', () => {
  it('deletes every tally row and shows no counts', async () => {
    const { pollId, invites } = await makePoll({
      voters: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com'],
    });
    for (const invite of invites.slice(0, 4)) castVote({ kind: 'token', token: invite.token }, 0);
    expect(tallyRepo.sumTallies(pollId)).toBe(4);

    // Walk the clock past the deadline and sweep.
    sweepExpiredPolls(new Date(Date.now() + 4 * DAY_MS));

    expect(tallyRepo.tallyRowCount(pollId)).toBe(0);
    const view = getPollView(pollId);
    expect(view?.status).toBe('failed');
    expect(view?.results).toBeNull();
    expect(view?.turnout).toBe(4); // turnout reached is shown; counts are gone
  });

  it('lazy evaluation fails the poll even if the sweeper never runs', async () => {
    const { pollId, invites } = await makePoll();
    castVote({ kind: 'token', token: invites[0]!.token }, 0);
    rewindClock(pollId, { closesAtMsAgo: 1000 });

    const view = getPollView(pollId); // a plain read is enough
    expect(view?.status).toBe('failed');
    expect(tallyRepo.tallyRowCount(pollId)).toBe(0);
  });
});

describe('Appendix A — a crash between consume and tally yields INVALID', () => {
  it('withholds results entirely when the counts do not reconcile', async () => {
    const { pollId, invites } = await makePoll();

    castVote({ kind: 'token', token: invites[0]!.token }, 0);
    castVote({ kind: 'token', token: invites[1]!.token }, 0);

    // Simulate the crash: step (a) succeeds, the process dies before step (b).
    const outcome = authRepo.consumeBallot(hashToken(invites[2]!.token), new Date().toISOString());
    expect(outcome.kind).toBe('consumed');

    const view = getPollView(pollId);
    expect(view?.status).toBe('completed');
    expect(view?.results?.integrity).toBe('INVALID');
    expect(view?.results?.counts).toEqual([]); // suppressed, not annotated
    expect(view?.results?.discrepancy).toMatch(/withheld/);
  });

  it('marks the poll at_risk when the tally write fails, and never double counts', async () => {
    const { pollId, invites } = await makePoll();
    // Remove the pre-seeded counters so the UPDATE matches no row.
    tallyRepo.deleteTallies(pollId);

    const result = castVote({ kind: 'token', token: invites[0]!.token }, 0);
    expect(result.kind).toBe('lost');
    expect(authRepo.getPoll(pollId)?.status).toBe('at_risk');

    // The ballot is still spent — failing closed means losing a vote, never reusing one.
    const retry = castVote({ kind: 'token', token: invites[0]!.token }, 0);
    expect(retry.kind).toBe('already_voted');
  });
});

describe('Appendix A — the results page reconciles', () => {
  it('total_ballots equals roster_size on a clean poll', async () => {
    const { pollId, invites } = await makePoll();
    invites.forEach((invite, i) => {
      const result = castVote({ kind: 'token', token: invite.token }, i === 2 ? 1 : 0);
      expect(result.kind).toBe('ok');
    });

    const view = getPollView(pollId);
    expect(view?.status).toBe('completed');
    expect(view?.results?.integrity).toBe('PASS');
    expect(view?.results?.totalBallots).toBe(3);
    expect(view?.results?.rosterSize).toBe(3);
    expect(view?.results?.counts).toEqual([2, 1]);
  });

  it('purges roster addresses once the result has been shown (FR-4.7)', async () => {
    const { pollId, invites } = await makePoll();
    for (const invite of invites) castVote({ kind: 'token', token: invite.token }, 0);

    expect(authRepo.listRosterEmails(pollId).length).toBeGreaterThan(0);
    getPollView(pollId); // first render
    expect(authRepo.listRosterEmails(pollId)).toEqual([]);

    // The integrity count survives the purge.
    const view = getPollView(pollId);
    expect(view?.results?.integrity).toBe('PASS');
    expect(view?.results?.totalBallots).toBe(3);
  });
});

describe('Appendix A — logs leak nothing', () => {
  it('a complete poll writes no token, email, code or option to the logs', async () => {
    const written: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const capture = (chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;

    let made: Awaited<ReturnType<typeof makePoll>>;
    try {
      made = await makePoll();
      for (const invite of made.invites) castVote({ kind: 'token', token: invite.token }, 0);
      getPollView(made.pollId);
      await flush();
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }

    const logs = written.join('\n');
    expect(logs).not.toMatch(/@example\.com/);
    for (const invite of made.invites) {
      expect(logs).not.toContain(invite.token);
      expect(logs).not.toContain(invite.code);
      expect(logs).not.toContain(hashToken(invite.token));
    }
    expect(logs).not.toMatch(/option_index/);
  });
});

describe('retention — a poll is deleted 7 days after it ends (§6.4)', () => {
  it('survives right up to the window, then is deleted entirely by the sweeper', async () => {
    const { pollId, invites } = await makePoll();
    for (const invite of invites) castVote({ kind: 'token', token: invite.token }, 0);
    expect(getPollView(pollId)?.results?.integrity).toBe('PASS');

    // One day short of the window: still there, still readable.
    rewindClock(pollId, { finalizedMsAgo: (RETENTION_DAYS_AFTER_END - 1) * DAY_MS });
    sweepExpiredPolls();
    expect(getPollView(pollId)?.results?.integrity).toBe('PASS');

    // Past the window: the poll, its ballots and its counts all go.
    rewindClock(pollId, { finalizedMsAgo: (RETENTION_DAYS_AFTER_END + 1) * DAY_MS });
    const swept = sweepExpiredPolls();
    expect(swept.deleted).toBe(1);

    expect(getPollView(pollId)).toBeNull();
    expect(authRepo.getPoll(pollId)).toBeNull();
    expect(authRepo.countTokens(pollId)).toBe(0);
    expect(tallyRepo.tallyRowCount(pollId)).toBe(0);
  });

  it('deletes on a plain read even if the sweeper never runs', async () => {
    const { pollId, invites } = await makePoll();
    for (const invite of invites) castVote({ kind: 'token', token: invite.token }, 0);
    rewindClock(pollId, { finalizedMsAgo: (RETENTION_DAYS_AFTER_END + 1) * DAY_MS });

    expect(getPollView(pollId)).toBeNull(); // the read itself deletes it
    expect(authRepo.getPoll(pollId)).toBeNull();
    expect(tallyRepo.tallyRowCount(pollId)).toBe(0);
  });

  it('deletes failed and cancelled polls on the same clock', async () => {
    const failed = await makePoll();
    rewindClock(failed.pollId, { closesAtMsAgo: 1000 });
    getPollView(failed.pollId); // fails it
    rewindClock(failed.pollId, { finalizedMsAgo: (RETENTION_DAYS_AFTER_END + 1) * DAY_MS });

    const cancelled = await makePoll();
    cancelPoll(cancelled.pollId, 'ravi@example.com');
    rewindClock(cancelled.pollId, { finalizedMsAgo: (RETENTION_DAYS_AFTER_END + 1) * DAY_MS });

    expect(sweepExpiredPolls().deleted).toBe(2);
    expect(authRepo.getPoll(failed.pollId)).toBeNull();
    expect(authRepo.getPoll(cancelled.pollId)).toBeNull();
  });

  it('leaves an open poll alone however old it is', async () => {
    const { pollId } = await makePoll({ durationDays: 7 });
    // finalized_at is null while a poll is open, so the retention clock has not started.
    expect(sweepExpiredPolls().deleted).toBe(0);
    expect(authRepo.getPoll(pollId)).not.toBeNull();
  });

  it('a deleted poll cannot be voted in, and says nothing about having existed', async () => {
    const { pollId, invites } = await makePoll();
    for (const invite of invites.slice(0, 2)) castVote({ kind: 'token', token: invite.token }, 0);
    rewindClock(pollId, { closesAtMsAgo: 1000 });
    getPollView(pollId);
    rewindClock(pollId, { finalizedMsAgo: (RETENTION_DAYS_AFTER_END + 1) * DAY_MS });

    const result = castVote({ kind: 'token', token: invites[2]!.token }, 0);
    // The same 404 an address that never existed gets.
    expect(result.kind).toBe('unknown');
    expect(authRepo.getPoll(pollId)).toBeNull();
  });

  it('tells voters the deletion date on every page that shows the poll', async () => {
    const { pollId, invites } = await makePoll();
    for (const invite of invites) castVote({ kind: 'token', token: invite.token }, 0);

    const view = getPollView(pollId);
    const finalizedAt = authRepo.getPoll(pollId)!.finalizedAt!;
    expect(view?.deletesAt).toBe(
      new Date(new Date(finalizedAt).getTime() + RETENTION_DAYS_AFTER_END * DAY_MS).toISOString(),
    );
  });

  it('warns about deletion in the invite email', async () => {
    await makePoll();
    for (const { body } of sentMail()) {
      expect(body.text).toMatch(/deleted 7 days after voting ends/);
    }
  });
});

describe('cancellation destroys the count (US-4)', () => {
  it('deletes tallies, purges addresses and tells nobody the partial result', async () => {
    const { pollId, invites } = await makePoll();
    castVote({ kind: 'token', token: invites[0]!.token }, 0);
    clearMail();

    const result = cancelPoll(pollId, 'ravi@example.com');
    expect(result.ok).toBe(true);
    await flush();

    expect(tallyRepo.tallyRowCount(pollId)).toBe(0);
    expect(authRepo.listRosterEmails(pollId)).toEqual([]);

    const view = getPollView(pollId);
    expect(view?.status).toBe('cancelled');
    expect(view?.results).toBeNull();

    const mail = sentMail();
    expect(mail.length).toBe(3);
    for (const { body } of mail) {
      expect(body.text).not.toMatch(/\b[12]\b vote/);
      expect(body.text).toMatch(/deleted/);
    }
  });

  it('only the creator can cancel', async () => {
    const { pollId } = await makePoll();
    const result = cancelPoll(pollId, 'priya@example.com');
    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});

describe('creation refuses what it cannot promise', () => {
  it('rejects a two-person poll outright (US-2, §2.2)', () => {
    const result = createPoll({
      question: 'Ship it?',
      rawOptions: ['Yes', 'No'],
      rawVoters: 'a@example.com, b@example.com',
      rawDurationDays: 3,
      creatorEmail: 'ravi@example.com',
      creatorVotes: false,
      allowAbstain: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least 3 voters/);
  });

  it('accepts only the standard 3, 5 and 7 day durations', async () => {
    for (const days of [0, 1, 2, 4, 6, 8, 14, -3, 3.5, 'soon', '', null, undefined]) {
      const result = createPoll({
        question: 'Ship it?',
        rawOptions: ['Yes', 'No'],
        rawVoters: 'a@example.com, b@example.com, c@example.com',
        rawDurationDays: days,
        creatorEmail: 'ravi@example.com',
        creatorVotes: false,
        allowAbstain: false,
      });
      expect(result.ok, `duration ${String(days)} should be rejected`).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/3, 5, 7 days/);
    }

    for (const days of ALLOWED_DURATION_DAYS) {
      const made = await makePoll({ durationDays: days });
      const poll = authRepo.getPoll(made.pollId)!;
      // The deadline is derived from the duration, not supplied by the caller,
      // and lands exactly N days after creation.
      expect(new Date(poll.closesAt).getTime() - new Date(poll.createdAt).getTime()).toBe(
        days * DAY_MS,
      );
    }
  });

  it('accepts a duration submitted as a form string', async () => {
    installCapturingTransport();
    const result = createPoll({
      question: 'Ship it?',
      rawOptions: ['Yes', 'No'],
      rawVoters: 'a@example.com, b@example.com, c@example.com',
      rawDurationDays: '5',
      creatorEmail: 'ravi@example.com',
      creatorVotes: false,
      allowAbstain: false,
    });
    expect(result.ok).toBe(true);
    await flush();
  });

  it('adds the creator to the roster only when they opt in (FR-1.4)', async () => {
    installCapturingTransport();
    const result = createPoll({
      question: 'Ship it?',
      rawOptions: ['Yes', 'No'],
      rawVoters: 'a@example.com, b@example.com, c@example.com',
      rawDurationDays: 3,
      creatorEmail: 'ravi@example.com',
      creatorVotes: true,
      allowAbstain: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.voterCount).toBe(4);
    await flush();
  });
});
