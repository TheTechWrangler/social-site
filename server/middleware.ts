import type { Request, Response, NextFunction } from 'express';
import { authenticateApplicationToken } from './auth.js';

// Mirrors clearAuthCookie in routes/auth.ts — kept here to avoid a circular import.
const IS_PROD = process.env.NODE_ENV === 'production';
function clearStaleCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, { httpOnly: true, secure: IS_PROD, sameSite: 'lax', path: '/' });
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
  // Passport may have populated req.user from its temporary OAuth session. The
  // application viewer always starts empty and can only come from the app JWT.
  (req as any).user = undefined;
  const token = getAuthCookieValue(req);
  if (!token) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const authenticated = authenticateApplicationToken(token);
  if (!authenticated.ok) {
    clearStaleCookie(res);
    if (authenticated.reason === 'unavailable') {
      res.status(403).json({ error: 'Account banned or not found.' });
      return;
    }
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }
  const user = authenticated.user;
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
  // Never inherit Passport identity on application routes. Passport sessions are
  // limited to OAuth state/callback/handoff mechanics.
  (req as any).user = undefined;
  const token = getAuthCookieValue(req);
  if (token) {
    const authenticated = authenticateApplicationToken(token);
    if (authenticated.ok) {
      const user = authenticated.user;
      (req as any).user = {
        id: user.id,
        username: user.username,
        role: user.role,
        is_verified: user.is_verified,
        game_discovery_enabled: user.game_discovery_enabled,
      };
    } else {
      clearStaleCookie(res);
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
