import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../database.js';
import { registerUser, generateToken, verifyPassword, getUserByUsername, getUserById, hashPassword, type AuthUser } from '../auth.js';
import { requireAuth, type AuthRequest } from '../middleware.js';
import { logAuthEvent, getClientIp } from '../authEvents.js';
import { logUsage } from '../usageEvents.js';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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
    logAuthEvent({ eventType: 'register_success', userId: user.id, ip: getClientIp(req), userAgent: req.headers['user-agent'], meta: { username: user.username } });
    logUsage({ eventType: 'register_success', userId: user.id, featureArea: 'account' });
    res.status(201).json({ user, token });
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
    // Update last_login_at and log success
    getDb().prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    logAuthEvent({ eventType: 'login_success', userId: user.id, ip, userAgent: ua, meta: { username: user.username } });
    logUsage({ eventType: 'login_success', userId: user.id, featureArea: 'account' });
    const token = generateToken(user);
    const { password_hash, ...safe } = user as any;
    res.json({ user: safe, token });
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
  if (!user) { res.status(400).json({ error: 'User not found.' }); return; }
  res.json({ ok: true, username: user.username });
});

// POST /api/auth/reset-password — apply new password with reset token (no auth required)
router.post('/reset-password', (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || typeof token !== 'string' || !newPassword || String(newPassword).length < 8) {
    res.status(400).json({ error: 'A valid token and password (min 8 characters) are required.' }); return;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  const db = getDb();
  const row = db.prepare(
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?'
  ).get(hash) as any;
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    res.status(400).json({ error: 'This reset link is invalid or has expired.' }); return;
  }
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(row.user_id) as any;
  if (!user) { res.status(400).json({ error: 'User not found.' }); return; }

  // Mark used FIRST — prevents race condition where password update fails but token stays valid
  db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?").run(row.id);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(newPassword)), user.id);

  logAuthEvent({ eventType: 'password_reset_completed', userId: user.id, ip: getClientIp(req), userAgent: req.headers['user-agent'], meta: { username: user.username } });
  res.json({ ok: true, message: 'Password updated. You can now log in with your new password.' });
});

// GET /api/auth/oauth-token — one-time JWT exchange after OAuth login (no prior auth required)
// The frontend calls this immediately after being redirected to /oauth/callback.
// The server stored the JWT in the session (server-side) during the OAuth callback so the
// token was never placed in a URL query string.  This endpoint reads it once and clears it.
router.get('/oauth-token', (req, res) => {
  const session = (req as any).session;
  const token: string | undefined = session?.oauthHandoffToken;
  const username: string | undefined = session?.oauthHandoffUsername;

  if (!token || !username) {
    // No handoff data — either already consumed, expired, or direct access without OAuth.
    res.status(401).json({ error: 'No OAuth session found. Please try logging in again.' });
    return;
  }

  // Consume immediately — one-time use. Delete before responding to prevent replay.
  delete session.oauthHandoffToken;
  delete session.oauthHandoffUsername;
  // Persist the deletion asynchronously; we don't need to wait before responding.
  session.save(() => {});

  res.json({ token, username });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req: AuthRequest, res) => {
  const user = getUserById(req.user!.id);
  res.json({ user });
});

export default router;
