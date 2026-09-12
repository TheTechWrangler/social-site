import type Database from 'better-sqlite3';

export function initializeOperationalAudit(db: Database.Database): void {
  // IDs deliberately have no foreign keys: evidence survives target/actor deletion.
  db.exec(`CREATE TABLE IF NOT EXISTS operational_audit (
    id INTEGER PRIMARY KEY, event_type TEXT NOT NULL,
    actor_id INTEGER, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  ); CREATE INDEX IF NOT EXISTS idx_operational_audit_created ON operational_audit(created_at, id)`);
}

/** Required evidence: failure propagates so the caller's mutation rolls back. No payload bodies. */
export function auditOperation(db: Database.Database, event: string, actor: number | null,
  targetType: string, targetId: string | number): void {
  if (!/^[a-z_.]{1,64}$/.test(event) || !/^[a-z_]{1,32}$/.test(targetType) || String(targetId).length > 100) {
    throw new Error('Invalid operational event');
  }
  db.prepare('INSERT INTO operational_audit(event_type, actor_id, target_type, target_id) VALUES (?, ?, ?, ?)')
    .run(event, actor, targetType, String(targetId));
}
