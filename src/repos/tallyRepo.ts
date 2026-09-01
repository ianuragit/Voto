import { tallyDb } from '../db/tally.js';

/**
 * The ONLY interface to tally.sqlite. Imports the tally connection and nothing
 * from the auth side (§7.4).
 *
 * Every function here takes a poll_id and an option index. None of them takes,
 * returns, or stores anything about a person.
 */

/** FR-1.6 — pre-seed one row per option at zero, so voting never INSERTs (§6.2.1). */
export function seedTallies(pollId: string, optionCount: number): void {
  const db = tallyDb();
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO tallies (poll_id, option_index, count) VALUES (?, ?, 0)',
  );
  db.transaction(() => {
    for (let i = 0; i < optionCount; i += 1) stmt.run(pollId, i);
  })();
}

/**
 * FR-3.2(b) — the entire vote-recording surface. One UPDATE, atomic under
 * SQLite's single-writer model. No timestamp, no order, no identity.
 */
export function incrementTally(pollId: string, optionIndex: number): boolean {
  const res = tallyDb()
    .prepare('UPDATE tallies SET count = count + 1 WHERE poll_id = ? AND option_index = ?')
    .run(pollId, optionIndex);
  return res.changes === 1;
}

/**
 * FR-4.2 — the only reader. Callers must have already established that the
 * poll is completed; there is no code path that reads tallies for an open poll
 * other than the integrity check at completion.
 */
export function readTallies(pollId: string): number[] {
  const rows = tallyDb()
    .prepare('SELECT option_index, count FROM tallies WHERE poll_id = ? ORDER BY option_index')
    .all(pollId) as { option_index: number; count: number }[];
  const out: number[] = [];
  for (const row of rows) out[row.option_index] = row.count;
  for (let i = 0; i < out.length; i += 1) if (out[i] === undefined) out[i] = 0;
  return out;
}

export function sumTallies(pollId: string): number {
  const row = tallyDb()
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM tallies WHERE poll_id = ?')
    .get(pollId) as { total: number };
  return row.total;
}

/** FR-4.6 / US-4 — failure and cancellation make the partial count unrecoverable. */
export function deleteTallies(pollId: string): void {
  tallyDb().prepare('DELETE FROM tallies WHERE poll_id = ?').run(pollId);
}

export function tallyRowCount(pollId: string): number {
  const row = tallyDb()
    .prepare('SELECT COUNT(*) AS n FROM tallies WHERE poll_id = ?')
    .get(pollId) as { n: number };
  return row.n;
}
