import { authDb } from '../db/auth.js';

/**
 * The ONLY interface to auth.sqlite. Imports the auth connection and nothing
 * from the tally side (§7.4).
 */

export type PollStatus = 'open' | 'completed' | 'failed' | 'cancelled' | 'at_risk';
export type DeliveryStatus = 'queued' | 'sent' | 'bounced' | 'failed';

export interface Poll {
  pollId: string;
  question: string;
  options: string[];
  voterCount: number;
  creatorEmail: string;
  configHash: string;
  createdAt: string;
  closesAt: string;
  status: PollStatus;
  finalizedAt: string | null;
  finalBallotCount: number | null;
  resultsNotified: boolean;
  emailsPurged: boolean;
}

export interface NewToken {
  tokenHash: string;
  codeHash: string;
  email: string;
}

export interface BallotToken {
  tokenHash: string;
  pollId: string;
  codeHash: string;
  email: string | null;
  consumed: boolean;
  deliveryStatus: DeliveryStatus;
}

interface PollRow {
  poll_id: string;
  question: string;
  options_json: string;
  voter_count: number;
  creator_email: string;
  config_hash: string;
  created_at: string;
  closes_at: string;
  status: PollStatus;
  finalized_at: string | null;
  final_ballot_count: number | null;
  results_notified: number;
  emails_purged: number;
}

interface TokenRow {
  token_hash: string;
  poll_id: string;
  code_hash: string;
  email: string | null;
  consumed: number;
  delivery_status: DeliveryStatus;
}

function toPoll(row: PollRow): Poll {
  return {
    pollId: row.poll_id,
    question: row.question,
    options: JSON.parse(row.options_json) as string[],
    voterCount: row.voter_count,
    creatorEmail: row.creator_email,
    configHash: row.config_hash,
    createdAt: row.created_at,
    closesAt: row.closes_at,
    status: row.status,
    finalizedAt: row.finalized_at,
    finalBallotCount: row.final_ballot_count,
    resultsNotified: row.results_notified === 1,
    emailsPurged: row.emails_purged === 1,
  };
}

function toToken(row: TokenRow): BallotToken {
  return {
    tokenHash: row.token_hash,
    pollId: row.poll_id,
    codeHash: row.code_hash,
    email: row.email,
    consumed: row.consumed === 1,
    deliveryStatus: row.delivery_status,
  };
}

export interface CreatePollInput {
  pollId: string;
  question: string;
  options: string[];
  voterCount: number;
  creatorEmail: string;
  configHash: string;
  createdAt: string;
  closesAt: string;
  tokens: NewToken[];
}

/** FR-1.6 — poll row and all N token rows land in one transaction. */
export function createPoll(input: CreatePollInput): void {
  const db = authDb();
  const insertPoll = db.prepare(
    `INSERT INTO polls (poll_id, question, options_json, voter_count, creator_email,
                        config_hash, created_at, closes_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  );
  const insertToken = db.prepare(
    `INSERT INTO ballot_tokens (token_hash, poll_id, code_hash, email)
     VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    insertPoll.run(
      input.pollId,
      input.question,
      JSON.stringify(input.options),
      input.voterCount,
      input.creatorEmail,
      input.configHash,
      input.createdAt,
      input.closesAt,
    );
    for (const t of input.tokens) {
      insertToken.run(t.tokenHash, input.pollId, t.codeHash, t.email);
    }
  })();
}

export function getPoll(pollId: string): Poll | null {
  const row = authDb().prepare('SELECT * FROM polls WHERE poll_id = ?').get(pollId) as
    | PollRow
    | undefined;
  return row ? toPoll(row) : null;
}

export function getTokenByHash(tokenHash: string): BallotToken | null {
  const row = authDb()
    .prepare('SELECT * FROM ballot_tokens WHERE token_hash = ?')
    .get(tokenHash) as TokenRow | undefined;
  return row ? toToken(row) : null;
}

export function getTokenByCodeHash(pollId: string, codeHash: string): BallotToken | null {
  const row = authDb()
    .prepare('SELECT * FROM ballot_tokens WHERE poll_id = ? AND code_hash = ?')
    .get(pollId, codeHash) as TokenRow | undefined;
  return row ? toToken(row) : null;
}

/** FR-4.1 — turnout is a count. There is no query in this file that returns who voted. */
export function countConsumed(pollId: string): number {
  const row = authDb()
    .prepare('SELECT COUNT(*) AS n FROM ballot_tokens WHERE poll_id = ? AND consumed = 1')
    .get(pollId) as { n: number };
  return row.n;
}

export function countTokens(pollId: string): number {
  const row = authDb()
    .prepare('SELECT COUNT(*) AS n FROM ballot_tokens WHERE poll_id = ?')
    .get(pollId) as { n: number };
  return row.n;
}

export type ConsumeOutcome =
  | { kind: 'consumed'; turnout: number; completed: boolean }
  | { kind: 'already_consumed' }
  | { kind: 'unknown_token' }
  | { kind: 'closed'; status: PollStatus };

/**
 * FR-2.6 / FR-3.2(a) / FR-3.6 / FR-4.3 — one transaction that:
 *   1. re-reads poll status and deadline (server clock is authoritative),
 *   2. consumes the token with a conditional UPDATE (acts on changes() === 1),
 *   3. recounts turnout, and flips the poll to `completed` at 100%.
 *
 * Returns without writing anything if the poll is not open or the deadline has
 * passed. The caller increments the tally only on `kind: 'consumed'`.
 */
export function consumeBallot(tokenHash: string, nowIso: string): ConsumeOutcome {
  const db = authDb();
  const txn = db.transaction((): ConsumeOutcome => {
    const token = db.prepare('SELECT * FROM ballot_tokens WHERE token_hash = ?').get(tokenHash) as
      | TokenRow
      | undefined;
    if (!token) return { kind: 'unknown_token' };

    const poll = db.prepare('SELECT * FROM polls WHERE poll_id = ?').get(token.poll_id) as
      | PollRow
      | undefined;
    if (!poll) return { kind: 'unknown_token' };

    // FR-2.5 — tokens are valid only while open and before closes_at.
    if (poll.status !== 'open' && poll.status !== 'at_risk') {
      return { kind: 'closed', status: poll.status };
    }
    if (nowIso >= poll.closes_at) {
      return { kind: 'closed', status: poll.status };
    }

    const res = db
      .prepare('UPDATE ballot_tokens SET consumed = 1 WHERE token_hash = ? AND consumed = 0')
      .run(tokenHash);
    if (res.changes !== 1) return { kind: 'already_consumed' };

    const { n: turnout } = db
      .prepare('SELECT COUNT(*) AS n FROM ballot_tokens WHERE poll_id = ? AND consumed = 1')
      .get(poll.poll_id) as { n: number };

    const completed = turnout === poll.voter_count && poll.status === 'open';
    if (completed) {
      db.prepare(
        `UPDATE polls SET status = 'completed', finalized_at = ?, final_ballot_count = ?
         WHERE poll_id = ? AND status = 'open'`,
      ).run(nowIso, turnout, poll.poll_id);
    }
    return { kind: 'consumed', turnout, completed };
  });
  return txn();
}

export function setStatus(pollId: string, status: PollStatus, nowIso?: string): void {
  const db = authDb();
  if (status === 'open') {
    db.prepare('UPDATE polls SET status = ? WHERE poll_id = ?').run(status, pollId);
    return;
  }
  const turnout = countConsumed(pollId);
  db.prepare(
    `UPDATE polls
       SET status = ?,
           finalized_at = COALESCE(finalized_at, ?),
           final_ballot_count = COALESCE(final_ballot_count, ?)
     WHERE poll_id = ?`,
  ).run(status, nowIso ?? new Date().toISOString(), turnout, pollId);
}

/** FR-3.3 — a lost ballot marks the poll at_risk. Never leaves `completed`. */
export function markAtRisk(pollId: string): void {
  authDb()
    .prepare(`UPDATE polls SET status = 'at_risk' WHERE poll_id = ? AND status IN ('open','completed')`)
    .run(pollId);
}

/** Roster, for sending mail. Never exposed through any voter- or creator-facing view of turnout. */
export function listTokens(pollId: string): BallotToken[] {
  const rows = authDb()
    .prepare('SELECT * FROM ballot_tokens WHERE poll_id = ? ORDER BY email')
    .all(pollId) as TokenRow[];
  return rows.map(toToken);
}

export function listRosterEmails(pollId: string): string[] {
  const rows = authDb()
    .prepare('SELECT email FROM ballot_tokens WHERE poll_id = ? AND email IS NOT NULL ORDER BY email')
    .all(pollId) as { email: string }[];
  return rows.map((r) => r.email);
}

/**
 * Delivery status per address (US-3). This is mail-transport state, not vote
 * state — it says nothing about who has voted.
 */
export function listDeliveryStatuses(pollId: string): { email: string; status: DeliveryStatus }[] {
  const rows = authDb()
    .prepare(
      `SELECT email, delivery_status FROM ballot_tokens
        WHERE poll_id = ? AND email IS NOT NULL ORDER BY email`,
    )
    .all(pollId) as { email: string; delivery_status: DeliveryStatus }[];
  return rows.map((r) => ({ email: r.email, status: r.delivery_status }));
}

export function setDeliveryStatusByHash(tokenHash: string, status: DeliveryStatus): void {
  authDb()
    .prepare('UPDATE ballot_tokens SET delivery_status = ? WHERE token_hash = ?')
    .run(status, tokenHash);
}

/** FR-2.8 — the bounce webhook only knows an address. */
export function setDeliveryStatusByEmail(email: string, status: DeliveryStatus): number {
  const res = authDb()
    .prepare(
      `UPDATE ballot_tokens SET delivery_status = ?
        WHERE email = ? AND poll_id IN (SELECT poll_id FROM polls WHERE status IN ('open','at_risk'))`,
    )
    .run(status, email.toLowerCase());
  return res.changes;
}

/** FR-1.8 — permitted only while nobody has voted; the caller checks that. */
export function replaceRosterEmail(input: {
  pollId: string;
  oldEmail: string;
  newEmail: string;
  tokenHash: string;
  codeHash: string;
  configHash: string;
}): boolean {
  const db = authDb();
  const txn = db.transaction((): boolean => {
    const existing = db
      .prepare('SELECT * FROM ballot_tokens WHERE poll_id = ? AND email = ?')
      .get(input.pollId, input.oldEmail) as TokenRow | undefined;
    if (!existing) return false;
    if (existing.consumed === 1) return false;

    db.prepare('DELETE FROM ballot_tokens WHERE token_hash = ?').run(existing.token_hash);
    db.prepare(
      `INSERT INTO ballot_tokens (token_hash, poll_id, code_hash, email) VALUES (?, ?, ?, ?)`,
    ).run(input.tokenHash, input.pollId, input.codeHash, input.newEmail);
    db.prepare('UPDATE polls SET config_hash = ? WHERE poll_id = ?').run(
      input.configHash,
      input.pollId,
    );
    return true;
  });
  return txn();
}

/**
 * Claims the right to send this poll's results email, atomically. Exactly one
 * caller ever wins, so the vote path and the sweeper cannot both mail the
 * whole roster. Returns false if someone already claimed it.
 */
export function claimResultsNotification(pollId: string): boolean {
  const res = authDb()
    .prepare('UPDATE polls SET results_notified = 1 WHERE poll_id = ? AND results_notified = 0')
    .run(pollId);
  return res.changes === 1;
}

/**
 * Polls that ended but whose voters were never told — the process died between
 * completing the poll and sending the mail. The sweeper finishes the job.
 */
export function listAwaitingResultsNotification(): Poll[] {
  const rows = authDb()
    .prepare(
      `SELECT * FROM polls
        WHERE status = 'completed' AND results_notified = 0 AND emails_purged = 0`,
    )
    .all() as PollRow[];
  return rows.map(toPoll);
}

/**
 * Replaces a ballot's credentials, preserving its `consumed` flag and address.
 * Used by resend and by roster correction. Because the consumed flag survives,
 * reissuing every ballot in a poll changes nothing about turnout.
 */
export function reissueToken(input: {
  pollId: string;
  oldTokenHash: string;
  tokenHash: string;
  codeHash: string;
}): boolean {
  const db = authDb();
  const txn = db.transaction((): boolean => {
    const existing = db
      .prepare('SELECT * FROM ballot_tokens WHERE token_hash = ? AND poll_id = ?')
      .get(input.oldTokenHash, input.pollId) as TokenRow | undefined;
    if (!existing) return false;
    db.prepare('DELETE FROM ballot_tokens WHERE token_hash = ?').run(input.oldTokenHash);
    db.prepare(
      `INSERT INTO ballot_tokens (token_hash, poll_id, code_hash, email, consumed, delivery_status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
    ).run(input.tokenHash, input.pollId, input.codeHash, existing.email, existing.consumed);
    return true;
  });
  return txn();
}

/** FR-4.7 — the finished poll retains no PII. Hash + consumed flag survive for the count. */
export function purgeEmails(pollId: string): void {
  const db = authDb();
  db.transaction(() => {
    db.prepare('UPDATE ballot_tokens SET email = NULL WHERE poll_id = ?').run(pollId);
    db.prepare('UPDATE polls SET emails_purged = 1 WHERE poll_id = ?').run(pollId);
  })();
}

/**
 * §6.4 — polls that ended before `cutoffIso`. Everything about them, results
 * included, is deleted once they pass the retention window.
 */
export function listPollsPastRetention(cutoffIso: string): string[] {
  const rows = authDb()
    .prepare('SELECT poll_id FROM polls WHERE finalized_at IS NOT NULL AND finalized_at < ?')
    .all(cutoffIso) as { poll_id: string }[];
  return rows.map((r) => r.poll_id);
}

/**
 * Deletes the poll and its ballots outright — question, options, roster,
 * token hashes, turnout, the lot. Call it only after the tally rows are gone,
 * so a crash between the two leaves the poll row behind to be retried rather
 * than orphaning counters nothing can find.
 */
export function deletePoll(pollId: string): void {
  const db = authDb();
  db.transaction(() => {
    db.prepare('DELETE FROM ballot_tokens WHERE poll_id = ?').run(pollId);
    db.prepare('DELETE FROM polls WHERE poll_id = ?').run(pollId);
  })();
}

export function listExpiredOpenPolls(nowIso: string): Poll[] {
  const rows = authDb()
    .prepare(`SELECT * FROM polls WHERE status IN ('open','at_risk') AND closes_at <= ?`)
    .all(nowIso) as PollRow[];
  return rows.map(toPoll);
}

export function listPollsByCreator(creatorEmail: string, limit = 50): Poll[] {
  const rows = authDb()
    .prepare('SELECT * FROM polls WHERE creator_email = ? ORDER BY created_at DESC LIMIT ?')
    .all(creatorEmail.toLowerCase(), limit) as PollRow[];
  return rows.map(toPoll);
}
