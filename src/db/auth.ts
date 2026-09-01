import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/**
 * THE AUTH STORE — auth.sqlite (§6.1).
 *
 * Knows WHO was invited and WHETHER they voted. It must never learn WHAT
 * anybody voted. This module is one half of the air gap: no module in this
 * codebase may import both `db/auth.ts` and `db/tally.ts`. Enforced by
 * `scripts/check-air-gap.mjs`, which runs in CI.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;   -- shrink the crash window in FR-3.2
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS polls (
  poll_id       TEXT PRIMARY KEY,
  question      TEXT NOT NULL,
  options_json  TEXT NOT NULL,
  voter_count   INTEGER NOT NULL,
  creator_email TEXT NOT NULL,
  config_hash   TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  closes_at     TEXT NOT NULL,
  status        TEXT NOT NULL
                CHECK (status IN ('open','completed','failed','cancelled','at_risk')),

  -- Poll-level bookkeeping. All aggregates; none of it is voter-identifying,
  -- and none of it records when any individual acted.
  finalized_at         TEXT,                 -- when the poll left 'open'; starts the 7-day clock
  final_ballot_count   INTEGER,              -- consumed count frozen at finalisation
  emails_purged        INTEGER NOT NULL DEFAULT 0 CHECK (emails_purged IN (0,1))
);

CREATE TABLE IF NOT EXISTS ballot_tokens (
  token_hash      TEXT PRIMARY KEY,
  poll_id         TEXT NOT NULL REFERENCES polls(poll_id) ON DELETE CASCADE,
  code_hash       TEXT NOT NULL,
  email           TEXT,
  consumed        INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0,1)),
  delivery_status TEXT NOT NULL DEFAULT 'queued'
                  CHECK (delivery_status IN ('queued','sent','bounced','failed'))
  -- deliberately absent: consumed_at, ip, user_agent
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_code ON ballot_tokens(poll_id, code_hash);
CREATE INDEX IF NOT EXISTS idx_poll ON ballot_tokens(poll_id);
`;

let db: Database.Database | null = null;

export function authDb(): Database.Database {
  if (db) return db;
  mkdirSync(config.DATA_DIR, { recursive: true });
  const handle = new Database(path.join(config.DATA_DIR, 'auth.sqlite'));
  handle.pragma('busy_timeout = 5000'); // §10 — DB locked -> 503, never a partial write
  handle.exec(SCHEMA);
  db = handle;
  return db;
}

export function closeAuthDb(): void {
  db?.close();
  db = null;
}
