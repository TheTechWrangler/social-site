/**
 * SQLiteSessionStore — a minimal express-session-compatible store backed by better-sqlite3.
 *
 * Why a custom store instead of a package?
 *   The common SQLite session store packages (connect-sqlite3, express-sqlite-session) use
 *   the callback-based `sqlite3` package, not better-sqlite3. Adding a second SQLite driver
 *   just for sessions is a larger surface than this ~70-line file that reuses the existing
 *   open connection and WAL configuration.
 *
 * Privacy/safety notes:
 *   - Sessions are stored server-side; the browser only holds the session ID cookie.
 *   - Session data includes Passport user info and the OAuth handoff token (short-lived).
 *   - Expired sessions are deleted on startup and every hour.
 *   - No session content is logged.
 */

import { Store } from 'express-session';
import { getDb } from './database.js';
import { isStoredSessionUnexpired, sessionExpiryEpochMs } from './sessionExpiry.js';

// How long between automatic expired-session cleanup sweeps.
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class SQLiteSessionStore extends Store {
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    super();
    // Run cleanup once on startup to clear any sessions left over from before a restart,
    // then on a regular interval.
    this.runCleanup();
    this.cleanupTimer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);
    // unref() lets Node.js exit cleanly even if the interval is still pending.
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private runCleanup(): void {
    try {
      const db = getDb();
      const nowMs = Date.now();
      const rows = db.prepare('SELECT sid, expire, expire_ms FROM sessions')
        .all() as Array<{ sid: string; expire: unknown; expire_ms: unknown }>;
      const staleIds = rows
        .filter(row => !isStoredSessionUnexpired(row.expire_ms ?? row.expire, nowMs))
        .map(row => row.sid);
      const remove = db.prepare('DELETE FROM sessions WHERE sid = ?');
      const removeStale = db.transaction((ids: string[]) => {
        for (const sid of ids) remove.run(sid);
      });
      removeStale(staleIds);
      if (staleIds.length > 0) {
        console.log(`[session] Cleaned up ${staleIds.length} expired or malformed session(s).`);
      }
      db.prepare('DELETE FROM application_auth_sessions WHERE expires_at_ms <= ?').run(nowMs);
    } catch (e) {
      // Non-fatal — log and continue. Missing sessions cause re-login, not data loss.
      console.error('[session] Cleanup error:', (e as Error).message);
    }
  }

  /** Read a session by ID. Returns null if not found or expired. */
  get(sid: string, callback: (err: any, session?: any) => void): void {
    try {
      const db = getDb();
      const row = db.prepare('SELECT sess, expire, expire_ms FROM sessions WHERE sid = ?')
        .get(sid) as { sess: string; expire: unknown; expire_ms: unknown } | undefined;
      if (!row) { callback(null, null); return; }
      if (!isStoredSessionUnexpired(row.expire_ms ?? row.expire)) {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        callback(null, null);
        return;
      }
      try {
        callback(null, JSON.parse(row.sess));
      } catch {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
        callback(null, null);
      }
    } catch (e) {
      callback(e);
    }
  }

  /** Create or update a session. Expiry is derived from the session cookie's expiry. */
  set(sid: string, session: any, callback?: (err?: any) => void): void {
    try {
      // Prefer the cookie's explicit expiry Date; fall back to originalMaxAge or 24 h.
      const expire = sessionExpiryEpochMs(session);

      getDb()
        .prepare(`
          INSERT INTO sessions (sid, sess, expire, expire_ms) VALUES (?, ?, ?, ?)
          ON CONFLICT(sid) DO UPDATE SET
            sess = excluded.sess,
            expire = excluded.expire,
            expire_ms = excluded.expire_ms
        `)
        .run(sid, JSON.stringify(session), expire, expire);

      callback?.();
    } catch (e) {
      callback?.(e);
    }
  }

  /** Delete a session (logout, invalidation). */
  destroy(sid: string, callback?: (err?: any) => void): void {
    try {
      getDb().prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      callback?.();
    } catch (e) {
      callback?.(e);
    }
  }

  /**
   * Refresh the expiry of an active session without changing its data.
   * Called by express-session on each request when the session is active.
   */
  touch(sid: string, session: any, callback?: (err?: any) => void): void {
    try {
      const expire = sessionExpiryEpochMs(session);

      getDb()
        .prepare('UPDATE sessions SET expire = ?, expire_ms = ? WHERE sid = ?')
        .run(expire, expire, sid);

      callback?.();
    } catch (e) {
      callback?.(e);
    }
  }
}
