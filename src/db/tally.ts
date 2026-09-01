import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/**
 * THE TALLY STORE — tally.sqlite (§6.1 / §7.3).
 *
 * Knows HOW MANY chose each option. It must never learn WHO, WHEN, or in what
 * ORDER. Three columns, no rowid, no timestamps, no identifiers beyond
 * poll_id — which is not voter-identifying.
 *
 * This module is the other half of the air gap: no module may import both
 * `db/auth.ts` and this file. Enforced by `scripts/check-air-gap.mjs`.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

CREATE TABLE IF NOT EXISTS tallies (
  poll_id      TEXT NOT NULL,
  option_index INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (poll_id, option_index)
) WITHOUT ROWID;                            -- no rowid => no insertion-order artifact
`;

let db: Database.Database | null = null;

export function tallyDb(): Database.Database {
  if (db) return db;
  mkdirSync(config.DATA_DIR, { recursive: true });
  const handle = new Database(path.join(config.DATA_DIR, 'tally.sqlite'));
  handle.pragma('busy_timeout = 5000');
  handle.exec(SCHEMA);
  db = handle;
  return db;
}

export function closeTallyDb(): void {
  db?.close();
  db = null;
}
