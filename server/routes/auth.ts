import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { getDb } from '../database.js';
import { registerUser, generateToken, verifyToken, verifyPassword, getUserByUsername, getUserById, hashPassword } from '../auth.js';
import { requireAuth, getAuthCookieValue, AUTH_COOKIE_NAME, type AuthRequest } from '../middleware.js';
import { logAuthEvent, getClientIp } from '../authEvents.js';
import { logUsage } from '../usageEvents.js';
import { sendEmail, buildVerificationEmail, buildPasswordResetEmail, isEmailConfigured } from '../email.js';
import { isTokenUnexpired, utcExpiryFromNow } from '../tokenExpiry.js';

const router = Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,30}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const IS_PROD = process.env.NODE_ENV === 'production';
// Cookie maxAge must match or be shorter than the JWT TOKEN_EXPIRY ('7d') in auth.ts.
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── Email verification helpers ───

/** Default TTL for verification tokens in hours. Override via EMAIL_VERIFICATION_TTL_HOURS. */
function getVerifTtlHours(): number {
  return Math.max(1, parseInt(process.env.EMAIL_VERIFICATION_TTL_HOURS || '24', 10));
}

/**
 * Generate a raw verification token, invalidate any prior unused tokens for the user,
 * store only the SHA-256 hash. Returns the raw (unhashed) token for use in the email link.
 */
function generateAndStoreVerifToken(userId: number): string {
  const ttlHours = getVerifTtlHours();
  const rawToken = randomBytes(32).toString('hex');
  const hash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = utcExpiryFromNow(ttlHours);
  const db = getDb();
  // Invalidate previous unused tokens so only the latest link works.
  db.prepare("UPDATE email_verification_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(userId);
  db.prepare(
    'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
  ).run(userId, hash, expiresAt);
  return rawToken;
}

/**
 * Build the verification URL pointing to the frontend /verify-email route.
 * Never puts the token in the API URL — it goes to the frontend page which then calls the API.
 */
function buildVerifyUrl(rawToken: string): string {
  const webBase = (process.env.WEB_BASE_URL || 'http://localhost:5174').replace(/\/$/, '');
  return `${webBase}/verify-email?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Send a verification email. Fire-and-forget safe — never throws; logs failures.
 * Returns true if the email was dispatched, false if email is not configured or send failed.
 */
async function sendVerificationEmail(email: string, rawToken: string): Promise<boolean> {
  const verifyUrl = buildVerifyUrl(rawToken);
  const ttlHours = getVerifTtlHours();
  const result = await sendEmail({
    to: email,
    subject: 'Verify your RefugeCloud email address',
    html: buildVerificationEmail(verifyUrl, ttlHours),
  });
  return result.ok;
}

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
router.post('/register', async (req, res) => {
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

    // Generate verification token and send email — fire-and-forget.
    // Failure must not block registration; user is already logged in via cookie.
    const rawVerifToken = generateAndStoreVerifToken(user.id);
    sendVerificationEmail(user.email, rawVerifToken)
      .then(sent => {
        logAuthEvent({
          eventType: 'email_verification_sent',
          userId: user.id,
          success: sent,
          ip: getClientIp(req),
          userAgent: req.headers['user-agent'],
          meta: { triggered_by: 'register', email_configured: isEmailConfigured() },
        });
      })
      .catch(err => console.error('[auth] Verification email error on register:', err.message));

    // Token is set as HttpOnly cookie — not returned in JSON body.
    // needsEmailVerification signals the frontend to show the "check your email" state.
    res.status(201).json({ user, needsEmailVerification: true });
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

// POST /api/auth/forgot-password — self-serve password reset request (no auth required).
// Anti-enumeration: always returns the same generic message whether the account exists or not.
// Rate-limited in index.ts (5 req / 15 min — tighter than general authLimiter).
router.post('/forgot-password', async (req, res) => {
  // Generic message used for ALL responses — success, not-found, banned, OAuth-only.
  const GENERIC_MSG = 'If an account matches, a password reset email has been sent.';

  const rawInput = (req.body?.emailOrUsername || '').toString().trim();
  const input = rawInput.toLowerCase();

  // Always respond with the same shape — validate format silently, not publicly.
  if (!input || input.length < 3 || input.length > 254) {
    res.json({ ok: true, message: GENERIC_MSG }); return;
  }

  const db = getDb();
  // Look up by email if input contains '@', otherwise by username.
  // Both lookups include banned=0 and non-empty password_hash so OAuth-only or
  // banned accounts never receive a reset email without revealing their existence.
  const user = (input.includes('@')
    ? db.prepare('SELECT id, email, password_hash FROM users WHERE email = ? AND banned = 0').get(input)
    : db.prepare('SELECT id, email, password_hash FROM users WHERE LOWER(username) = ? AND banned = 0').get(input)
  ) as { id: number; email: string; password_hash: string } | undefined;

  // No account, banned, or OAuth-only (empty password_hash) — generic success, no email.
  if (!user || !user.password_hash) {
    res.json({ ok: true, message: GENERIC_MSG }); return;
  }

  // Determine TTL — default 1 hour (shorter than admin-generated 2-hour links).
  const ttlHours = Math.max(1, parseInt(process.env.PASSWORD_RESET_TTL_HOURS || '1', 10));

  try {
    // Invalidate any existing unused tokens to ensure only the newest link works.
    db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(user.id);

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = utcExpiryFromNow(ttlHours);
    db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, tokenHash, expiresAt);

    // Build the reset URL pointing to the frontend route (not the API).
    const webBase = (process.env.WEB_BASE_URL || 'http://localhost:5174').replace(/\/$/, '');
    const resetUrl = `${webBase}/reset-password?token=${rawToken}`;

    // Send email — fire-and-forget. Failure must not block the response or reveal account state.
    const emailResult = await sendEmail({
      to: user.email,
      subject: 'Reset your RefugeCloud password',
      html: buildPasswordResetEmail(resetUrl, ttlHours),
    });

    // Audit log — only logged when we know the user_id (never for not-found cases).
    logAuthEvent({
      eventType: 'password_reset_requested',
      userId: user.id,
      success: emailResult.ok,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      meta: { email_configured: isEmailConfigured(), self_serve: true },
    });
  } catch (err: any) {
    // Log the error internally but still return the generic message.
    console.error('[auth] Forgot password error:', err.message);
  }

  res.json({ ok: true, message: GENERIC_MSG });
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
  if (!row || row.used_at || !isTokenUnexpired(row.expires_at)) {
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
      if (!row || row.used_at || !isTokenUnexpired(row.expires_at)) {
        return { ok: false };
      }
      const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(row.user_id) as any;
      if (!user) return { ok: false };

      const tokenUpdate = db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(row.id);
      if (tokenUpdate.changes !== 1) return { ok: false };

      const passwordUpdate = db.prepare("UPDATE users SET password_hash = ?, password_changed_at = datetime('now') WHERE id = ?").run(newPasswordHash, user.id);
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

// GET /api/auth/verify-email?token=<raw-token>
// No auth required — user clicks the link from their email.
// Validates token, marks it used in a transaction, sets is_verified=1 on the user.
router.get('/verify-email', (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string' || token.length < 10) {
    res.status(400).json({ error: 'Invalid verification link.' }); return;
  }
  const hash = createHash('sha256').update(token).digest('hex');
  const db = getDb();
  try {
    const result = db.transaction((): { ok: true; userId: number } | { ok: false } => {
      const row = db.prepare(
        'SELECT id, user_id, expires_at, used_at FROM email_verification_tokens WHERE token_hash = ?'
      ).get(hash) as any;
      if (!row || row.used_at || !isTokenUnexpired(row.expires_at)) {
        return { ok: false };
      }
      const user = db.prepare('SELECT id, is_verified FROM users WHERE id = ?').get(row.user_id) as any;
      if (!user) return { ok: false };

      // Mark token used.
      const tokenUpdate = db.prepare(
        "UPDATE email_verification_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL"
      ).run(row.id);
      if (tokenUpdate.changes !== 1) return { ok: false };

      // Set verified (idempotent if already verified).
      db.prepare(
        "UPDATE users SET is_verified = 1, verified_at = datetime('now') WHERE id = ?"
      ).run(user.id);

      return { ok: true, userId: user.id };
    })();

    if (!result.ok) {
      res.status(400).json({ error: 'Invalid or expired verification link.' }); return;
    }

    logAuthEvent({
      eventType: 'email_verification_completed',
      userId: result.userId,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
    });

    // Fetch the updated user row (is_verified is now 1) and issue a fresh auth cookie.
    // This means a logged-in user gets their JWT refreshed immediately — no re-login
    // required. A user who clicked the link on a new device also gets logged in.
    // Raw JWT is never returned in JSON — only set as an HttpOnly cookie.
    const updatedUser = getUserById(result.userId);
    if (updatedUser && !updatedUser.banned) {
      const freshToken = generateToken(updatedUser);
      setAuthCookie(res, freshToken);
      res.json({ ok: true, user: updatedUser });
    } else {
      // Verified but user not found or banned (rare edge case) — report success without cookie.
      res.json({ ok: true });
    }
  } catch (err: any) {
    console.error('[auth] Verify email error:', err.message);
    res.status(500).json({ error: 'Could not verify email.' });
  }
});

// POST /api/auth/resend-verification
// Requires auth. Rate-limited in index.ts alongside other auth endpoints.
// Generates a fresh token and sends a new verification email.
// Always returns a generic success so the response doesn't reveal verification state to third parties.
router.post('/resend-verification', requireAuth, async (req: AuthRequest, res) => {
  const userId = req.user!.id;
  try {
    const user = getUserById(userId);
    if (!user) { res.status(404).json({ error: 'User not found.' }); return; }

    // If already verified, return success silently — no token generated.
    if (user.is_verified) {
      res.json({ ok: true, message: 'If verification is needed, a new email has been sent.' });
      return;
    }

    const rawToken = generateAndStoreVerifToken(userId);
    const sent = await sendVerificationEmail(user.email, rawToken);

    logAuthEvent({
      eventType: 'email_verification_resent',
      userId,
      success: sent,
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'],
      meta: { email_configured: isEmailConfigured() },
    });

    res.json({ ok: true, message: 'If verification is needed, a new email has been sent.' });
  } catch (err: any) {
    console.error('[auth] Resend verification error:', err.message);
    // Return generic success even on error to prevent enumeration.
    res.json({ ok: true, message: 'If verification is needed, a new email has been sent.' });
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
