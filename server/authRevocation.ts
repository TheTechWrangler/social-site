import type Database from 'better-sqlite3';

/** Rotate the application credential version and revoke every recorded JWT session. */
export function revokeAllApplicationSessionsInDb(
  db: Database.Database,
  userId: number,
  nowMs = Date.now(),
): void {
  const userUpdate = db.prepare(
    'UPDATE users SET auth_version = auth_version + 1 WHERE id = ?',
  ).run(userId);
  if (userUpdate.changes !== 1) throw new Error('AUTH_REVOCATION_USER_NOT_FOUND');
  db.prepare(`
    UPDATE application_auth_sessions
    SET revoked_at_ms = COALESCE(revoked_at_ms, ?)
    WHERE user_id = ?
  `).run(nowMs, userId);
}
