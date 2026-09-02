import type { Database } from 'better-sqlite3';

/**
 * Additive schema repair.
 *
 * Both stores are created with `CREATE TABLE IF NOT EXISTS`, which is a no-op
 * against a volume that already holds the table — so a column added to the DDL
 * later never appears on an existing deployment, and the first query touching
 * it fails with "no such column" at boot. That is a crash loop on a volume full
 * of real polls, which is the worst possible time to discover it.
 *
 * This adds any missing column, and does nothing else. It never drops, renames
 * or retypes anything: a column that exists is left exactly as it is, so this
 * cannot destroy data on a rollback to an older build.
 *
 * Takes a connection as an argument rather than importing one, so it stays on
 * the safe side of the air gap (§7.4) and can serve both stores.
 */
export type ColumnSpec = Record<string, Record<string, string>>;

export function ensureColumns(db: Database, spec: ColumnSpec): string[] {
  const added: string[] = [];
  for (const [table, columns] of Object.entries(spec)) {
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
    // A table that does not exist at all is the CREATE statement's job.
    if (existing.size === 0) continue;

    for (const [column, definition] of Object.entries(columns)) {
      if (existing.has(column)) continue;
      // SQLite forbids PRIMARY KEY/UNIQUE on an added column, and a NOT NULL
      // one needs a non-null default — every definition below satisfies that.
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      added.push(`${table}.${column}`);
    }
  }
  return added;
}
