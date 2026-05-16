import type { Request, Response, NextFunction } from 'express';
import { verifyToken, getUserById } from './auth.js';

// Mirrors clearAuthCookie in routes/auth.ts — kept here to avoid a circular import.
const IS_PROD = process.env.NODE_ENV === 'production';
function clearStaleCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', path: '/' });
}

/**
 * Returns true when a token's issued-at time predates the user's last password
 * change, meaning the token should no longer be trusted.
 * iat is in Unix seconds; password_changed_at is a UTC datetime string from SQLite.
 */
function isStaleToken(iat: number | undefined, passwordChangedAt: string | null): boolean {
  if (!iat) return true; // no iat — reject defensively
  if (!passwordChangedAt) return false; // no password change recorded — token is valid
  const changedAtMs = new Date(passwordChangedAt + 'Z').getTime();
  return iat * 1000 < changedAtMs;
}

declare global {
  namespace Express {
    interface User {
      id: number;
      username: string;
      role: string;
      is_verified: number;
      profile_visibility: string;
      game_discovery_enabled: number;
    }
  }
}

export type AuthRequest = Request;

// ─── Cookie helpers ───
// Cookie name must match setAuthCookie / clearAuthCookie in routes/auth.ts.
export const AUTH_COOKIE_NAME = 'refugecloud_auth';

/**
 * Extract the auth JWT from the HttpOnly cookie.
 * Parses the raw Cookie header without a third-party cookie-parser dependency.
 * JWT values are base64url + periods — no URI encoding needed, but we
 * call decodeURIComponent defensively in case a proxy rewrote the header.
 */
export function getAuthCookieValue(req: Request): string | undefined {
  const cookieStr = req.headers.cookie;
  if (!cookieStr) return undefined;
  const re = /(?:^|;\s*)refugecloud_auth=([^;]+)/;
  const m = cookieStr.match(re);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]); } catch { return undefined; }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getAuthCookieValue(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }
  const user = getUserById(payload.id);
  if (!user || user.banned) {
    res.status(403).json({ error: 'Account banned or not found.' });
    return;
  }
  // Revoke tokens issued before the user's last password change.
  // Uses the JWT iat (issued-at) claim vs password_changed_at in the DB.
  // Existing users with null password_changed_at are unaffected.
  if (isStaleToken(payload.iat, user.password_changed_at)) {
    clearStaleCookie(res);
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }
  (req as any).user = {
    id: user.id,
    username: user.username,
    role: user.role,
    is_verified: user.is_verified,
    game_discovery_enabled: user.game_discovery_enabled,
  };
  next();
}

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getAuthCookieValue(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      const user = getUserById(payload.id);
      if (user && !user.banned && !isStaleToken(payload.iat, user.password_changed_at)) {
        (req as any).user = {
          id: user.id,
          username: user.username,
          role: user.role,
          is_verified: user.is_verified,
          game_discovery_enabled: user.game_discovery_enabled,
        };
      } else if (user && isStaleToken(payload.iat, user.password_changed_at)) {
        // Silently clear the stale cookie so the browser stops sending it.
        clearStaleCookie(res);
      }
    }
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}

export function requireVerified(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user) { res.status(401).json({ error: 'Authentication required.' }); return; }
  if (user.role === 'admin') { next(); return; }
  if (!user.is_verified) {
    res.status(403).json({ error: 'Account verification required before you can interact.' });
    return;
  }
  next();
}
