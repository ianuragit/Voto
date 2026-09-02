import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ensureColumns } from '../src/db/migrate.js';

/**
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
 * exists, so a schema change reaches a fresh volume and silently misses a
 * live one. Every test in this file uses a database that predates the column,
 * which is the case the test suite otherwise never sees: it always starts from
 * an empty directory.
 */
function oldDatabase(): Database.Database {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'voto-migrate-'));
  const db = new Database(path.join(dir, 'auth.sqlite'));
  db.exec(`
    CREATE TABLE polls (
      poll_id TEXT PRIMARY KEY,
      question TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO polls (poll_id, question, status) VALUES ('p1', 'Ship it?', 'completed');
  `);
  return db;
}

const columnsOf = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

describe('an existing volume is brought up to date on open', () => {
  it('adds a column the running code needs', () => {
    const db = oldDatabase();
    expect(columnsOf(db, 'polls')).not.toContain('results_notified');

    const added = ensureColumns(db, {
      polls: { results_notified: 'INTEGER NOT NULL DEFAULT 0' },
    });

    expect(added).toEqual(['polls.results_notified']);
    expect(columnsOf(db, 'polls')).toContain('results_notified');

    // The query that used to crash the process at boot now works.
    const row = db
      .prepare("SELECT poll_id FROM polls WHERE status = 'completed' AND results_notified = 0")
      .get() as { poll_id: string };
    expect(row.poll_id).toBe('p1');
    db.close();
  });

  it('keeps the rows that were already there', () => {
    const db = oldDatabase();
    ensureColumns(db, { polls: { results_notified: 'INTEGER NOT NULL DEFAULT 0' } });

    const row = db.prepare('SELECT * FROM polls WHERE poll_id = ?').get('p1') as Record<
      string,
      unknown
    >;
    expect(row.question).toBe('Ship it?');
    expect(row.results_notified).toBe(0); // the default, not null
    db.close();
  });

  it('is idempotent and leaves an up-to-date database untouched', () => {
    const db = oldDatabase();
    const spec = { polls: { results_notified: 'INTEGER NOT NULL DEFAULT 0' } };

    expect(ensureColumns(db, spec)).toHaveLength(1);
    expect(ensureColumns(db, spec)).toEqual([]); // second open changes nothing
    expect(ensureColumns(db, spec)).toEqual([]);
    db.close();
  });

  it('never touches a column that already exists, whatever its current value', () => {
    const db = oldDatabase();
    ensureColumns(db, { polls: { results_notified: 'INTEGER NOT NULL DEFAULT 0' } });
    db.prepare('UPDATE polls SET results_notified = 1 WHERE poll_id = ?').run('p1');

    // A redeploy must not reset it back to the default.
    ensureColumns(db, { polls: { results_notified: 'INTEGER NOT NULL DEFAULT 0' } });

    const row = db.prepare('SELECT results_notified AS n FROM polls WHERE poll_id = ?').get('p1') as {
      n: number;
    };
    expect(row.n).toBe(1);
    db.close();
  });

  it('ignores a table that does not exist yet — that is the CREATE statement\'s job', () => {
    const db = oldDatabase();
    expect(ensureColumns(db, { not_a_table: { whatever: 'TEXT' } })).toEqual([]);
    db.close();
  });
});
