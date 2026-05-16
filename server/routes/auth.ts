import { Router } from 'express';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { getDb } from '../database.js';
import { registerUser, generateToken, verifyToken, verifyPassword, getUserByUsername, getUserById, hashPassword } from '../auth.js';
import { requireAuth, getAuthCookieValue, AUTH_COOKIE_NAME, type AuthRequest } from '../middleware.js';
import { logAuthEvent, getClientIp } from '../authEvents.js';
import { logUsage } from '../usageEvents.js';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IS_PROD = process.env.NODE_ENV === 'production';
// Cookie maxAge must match or be shorter than the JWT TOKEN_EXPIRY ('7d') in auth.ts.
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Cookie helpers (exported so other auth-adjacent routes can reuse) ───

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,          // Not accessible to JavaScript
    secure: IS_PROD,         // HTTPS-only in production; allows HTTP in dev
    sameSite: 'lax',         // Blocks cross-site POST CSRF; allows top-level nav
    path: '/',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    path: '/',
  });
}

// POST /api/auth/register
router.post('/register', (req, res) => {
  try {
    const { username, displayName, email, password } = req.body;
    if (!username || !displayName || !email || !password) {
      res.status(400).json({ error: 'All fields required.' }); return;
    }
    if (!USERNAME_RE.test(username.trim())) {
      res.status(400).json({ error: 'Username must be 3–30 characters and contain only letters, numbers, or underscores.' }); return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      res.status(400).json({ error: 'A valid email address is required.' }); return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters.' }); return;
    }
    const user = registerUser(username.trim(), displayName.trim(), email.trim().toLowerCase(), password);
    const token = generateToken(user);
    setAuthCookie(res, token);
    logAuthEvent({ eventType: 'register_success', userId: user.id, ip: getClientIp(req), userAgent: req.headers['user-agent'], meta: { username: user.username } });
    logUsage({ eventType: 'register_success', userId: user.id, featureArea: 'account' });
    // Token is set as HttpOnly cookie — not returned in JSON body.
    res.status(201).json({ user });
  } catch (err: any) {
    const message = err.message === 'Username or email already taken.'
      ? err.message
      : 'Could not create account.';
    if (message !== err.message) console.error('[auth] Register error:', err.message);
    res.status(400).json({ error: message });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'];
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password required.' }); return;
    }
    const user = getUserByUsername(username.trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      // Safe: same response for unknown user vs wrong password — no enumeration
      logAuthEvent({ eventType: 'login_failure', success: false, reason: 'INVALID_CREDENTIALS', ip, userAgent: ua, meta: { attemptedUsername: username.trim().slice(0, 60) } });
      res.status(401).json({ error: 'Invalid credentials.' }); return;
    }
    if (user.banned) {
      logAuthEvent({ eventType: 'login_failure', userId: user.id, success: false, reason: 'ACCOUNT_BANNED', ip, userAgent: ua, meta: { username: user.username } });
      res.status(403).json({ error: 'Account is banned.' }); return;
    }
    getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    logAuthEvent({ eventType: 'login_success', userId: user.id, ip, userAgent: ua, meta: { username: user.username } });
    logUsage({ eventType: 'login_success', userId: user.id, featureArea: 'account' });
    const token = generateToken(user);
    setAuthCookie(res, token);
    const { password_hash, ...safe } = user as any;
    // Token is set as HttpOnly cookie — not returned in JSON body.
    res.json({ user: safe });
  } catch (err: any) {
    console.error('[auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed.' });
  }
});

// GET /api/auth/reset-password?token=<token> — validate a reset token (no auth required)
router.get('/reset-password', (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string' || token.length < 10) {
    res.status(400).json({ error: 'Invalid reset token.' }); return;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  const row = getDb().prepare(
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?'
  ).get(hash) as any;
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    res.status(400).json({ error: 'This reset link is invalid or has expired.' }); return;
  }
  const user = getDb().prepare('SELECT id, username FROM users WHERE id = ?').get(row.user_id) as any;
  if (!user) { res.status(400).json({ error: 'This reset link is invalid or has expired.' }); return; }
  res.json({ ok: true, username: user.username });
});

// POST /api/auth/reset-password — apply new password with reset token (no auth required)
router.post('/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || typeof token !== 'string' || !newPassword || String(newPassword).length < 8) {
    res.status(400).json({ error: 'A valid token and password (min 8 characters) are required.' }); return;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  // Compute hash outside the transaction — bcrypt is ~100ms and holding the
  // SQLite write lock for that long would block all concurrent DB operations.
  const newPasswordHash = hashPassword(String(newPassword));
  const db = getDb();
  try {
    const result = db.transaction((): { ok: true; user: { id: number; username: string } } | { ok: false } => {
      const row = db.prepare(
        'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?'
      ).get(hash) as any;
      if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
        return { ok: false };
      }
      const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(row.user_id) as any;
      if (!user) return { ok: false };

      const tokenUpdate = db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(row.id);
      if (tokenUpdate.changes !== 1) return { ok: false };

      const passwordUpdate = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newPasswordHash, user.id);
      if (passwordUpdate.changes !== 1) throw new Error('PASSWORD_UPDATE_FAILED');

      return { ok: true, user: { id: user.id, username: user.username } };
    })();

    if (!result.ok) {
      res.status(400).json({ error: 'This reset link is invalid or has expired.' }); return;
    }

    logAuthEvent({ eventType: 'password_reset_completed', userId: result.user.id, ip: getClientIp(req), userAgent: req.headers['user-agent'], meta: { username: result.user.username } });
    res.json({ ok: true, message: 'Password updated. You can now log in with your new password.' });
  } catch (err: any) {
    console.error('[auth] Password reset error:', err.message);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// GET /api/auth/oauth-token — one-time OAuth handoff: sets the HttpOnly auth cookie,
// returns the full user object. Token is NEVER exposed to JavaScript.
// The server stored the JWT in session during the OAuth callback (not in the URL).
// This endpoint claims it once, sets the cookie, clears the session data, returns the user.
router.get('/oauth-token', (req, res) => {
  const session = (req as any).session;
  const token: string | undefined = session?.oauthHandoffToken;
  const username: string | undefined = session?.oauthHandoffUsername;

  if (!token || !username) {
    // No handoff data — already consumed, expired, or direct access without OAuth.
    res.status(401).json({ error: 'No OAuth session found. Please try logging in again.' });
    return;
  }

  // Consume immediately — one-time use. Delete before responding to prevent replay.
  delete session.oauthHandoffToken;
  delete session.oauthHandoffUsername;
  session.save(() => {});

  // Verify the stored token and fetch the canonical user
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'OAuth session expired. Please try logging in again.' });
    return;
  }
  const user = getUserById(payload.id);
  if (!user || user.banned) {
    res.status(401).json({ error: 'Account unavailable. Please try logging in again.' });
    return;
  }

  // Set the HttpOnly auth cookie — token never sent to frontend JS.
  setAuthCookie(res, token);
  res.json({ ok: true, user });
});

// POST /api/auth/logout — clears the HttpOnly auth cookie and audit-logs the event.
// Always clears the cookie regardless of whether auth is valid, so logout never
// "traps" a user with an expired/missing token. Returns { ok: true } unconditionally.
router.post('/logout', (req, res) => {
  // Soft-auth: try to identify the user for audit purposes but don't block on failure.
  const token = getAuthCookieValue(req);
  if (token) {
    try {
      const payload = verifyToken(token);
      if (payload) {
        const user = getUserById(payload.id);
        if (user) {
          logAuthEvent({
            eventType: 'logout',
            userId: user.id,
            ip: getClientIp(req),
            userAgent: req.headers['user-agent'],
            meta: { username: user.username },
          });
        }
      }
    } catch { /* never block logout */ }
  }
  clearAuthCookie(res);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: AuthRequest, res) => {
  const user = getUserById(req.user!.id);
  res.json({ user });
});

export default router;
