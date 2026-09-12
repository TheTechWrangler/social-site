import type Database from 'better-sqlite3';

export function prepareMigrationLedger(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
}

/** Nested calls use SQLite savepoints; a failed step never gets a ledger entry. */
export function applyMigration(db: Database.Database, id: string, work: () => void): void {
  db.transaction(() => {
    prepareMigrationLedger(db);
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(id)) return;
    work();
    db.prepare('INSERT INTO schema_migrations(id) VALUES (?)').run(id);
  }).immediate();
}
