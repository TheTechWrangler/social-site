import bcrypt from 'bcryptjs';
import type Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { randomBytes } from 'node:crypto';
import { getDb } from './database.js';
import { revokeAllApplicationSessionsInDb } from './authRevocation.js';

// Production startup check is in server/index.ts. This fallback is dev-only.
const JWT_SECRET = process.env.JWT_SECRET || 'social-site-dev-secret-change-in-production';
const TOKEN_EXPIRY = '7d';
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export interface AuthUser {
  id: number;
  username: string;
  display_name: string;
  email: string;
  role: string;
  banned: number;
  is_verified: number;
  profile_visibility: string;
  feed_exposure: string;
  world_home_injection: string;
  game_discovery_enabled: number;
  dm_privacy: string;
  auth_version: number;
  /** UTC datetime string; NULL means no password change recorded — existing tokens stay valid. */
  password_changed_at: string | null;
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function generateToken(user: AuthUser): string {
  const sessionId = randomBytes(32).toString('hex');
  const nowMs = Date.now();
  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      is_verified: user.is_verified,
      isVerified: !!user.is_verified,
      banned: user.banned,
      auth_version: user.auth_version,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY, jwtid: sessionId }
  );
  getDb().prepare(`
    INSERT INTO application_auth_sessions
      (session_id, user_id, expires_at_ms, created_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, user.id, nowMs + TOKEN_EXPIRY_MS, nowMs);
  return token;
}

export interface AuthTokenPayload {
  id: number;
  username: string;
  role: string;
  is_verified?: number;
  isVerified?: boolean;
  banned?: number;
  auth_version?: number;
  iat?: number;
  exp?: number;
  jti?: string;
}

export function verifyToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as AuthTokenPayload;
  } catch {
    return null;
  }
}

function legacyTokenIsStale(iat: number | undefined, passwordChangedAt: string | null): boolean {
  if (!iat) return true;
  if (!passwordChangedAt) return false;
  const timestamp = Date.parse(`${passwordChangedAt.replace(' ', 'T')}Z`);
  return !Number.isFinite(timestamp) || iat * 1000 < timestamp;
}

export type ApplicationAuthResult =
  | { ok: true; user: AuthUser; payload: AuthTokenPayload }
  | { ok: false; reason: 'invalid' | 'revoked' | 'unavailable' };

/** Resolve the sole application authorization credential to canonical DB state. */
export function authenticateApplicationToken(token: string, nowMs = Date.now()): ApplicationAuthResult {
  const payload = verifyToken(token);
  if (!payload || !Number.isSafeInteger(payload.id) || payload.id <= 0) {
    return { ok: false, reason: 'invalid' };
  }
  const user = getUserById(payload.id);
  if (!user || user.banned) return { ok: false, reason: 'unavailable' };

  const currentVersion = Number(user.auth_version ?? 0);
  if (payload.auth_version === undefined) {
    // Deployment compatibility for JWTs issued before auth_version existed.
    if (currentVersion !== 0 || legacyTokenIsStale(payload.iat, user.password_changed_at)) {
      return { ok: false, reason: 'revoked' };
    }
  } else if (!Number.isSafeInteger(payload.auth_version) || payload.auth_version !== currentVersion) {
    return { ok: false, reason: 'revoked' };
  }

  if (payload.auth_version !== undefined && (typeof payload.jti !== 'string' || payload.jti.length < 32)) {
    return { ok: false, reason: 'revoked' };
  }
  if (payload.jti) {
    const session = getDb().prepare(`
      SELECT user_id, expires_at_ms, revoked_at_ms
      FROM application_auth_sessions
      WHERE session_id = ?
    `).get(payload.jti) as { user_id: number; expires_at_ms: number; revoked_at_ms: number | null } | undefined;
    if (!session || session.user_id !== user.id || session.revoked_at_ms !== null || session.expires_at_ms <= nowMs) {
      return { ok: false, reason: 'revoked' };
    }
  }

  return { ok: true, user, payload };
}

/** Revoke every application credential after a password or account-security change. */
export function revokeAllApplicationSessions(userId: number, nowMs = Date.now()): void {
  const db = getDb();
  revokeAllApplicationSessionsInDb(db, userId, nowMs);
}

/** Revoke only the presented application session. Legacy JWTs require version rotation. */
export function revokeApplicationToken(token: string, nowMs = Date.now()): void {
  const authenticated = authenticateApplicationToken(token, nowMs);
  if (!authenticated.ok) return;
  if (authenticated.payload.jti) {
    getDb().prepare(`
      UPDATE application_auth_sessions
      SET revoked_at_ms = COALESCE(revoked_at_ms, ?)
      WHERE session_id = ? AND user_id = ?
    `).run(nowMs, authenticated.payload.jti, authenticated.user.id);
    return;
  }
  revokeAllApplicationSessions(authenticated.user.id, nowMs);
}

export function getUserById(id: number): AuthUser | null {
  const row = getDb().prepare(
    'SELECT id, username, display_name, email, role, banned, is_verified, profile_visibility, feed_exposure, world_home_injection, game_discovery_enabled, dm_privacy, auth_version, password_changed_at FROM users WHERE id = ?'
  ).get(id) as AuthUser | undefined;
  return row ?? null;
}

export function getUserByUsername(username: string): (AuthUser & { password_hash: string }) | null {
  const row = getDb().prepare(
    'SELECT * FROM users WHERE username = ? COLLATE NOCASE'
  ).get(username) as any;
  return row ?? null;
}

export function registerUser(username: string, displayName: string, email: string, password: string): AuthUser {
  const db = getDb();
  const normalizedUsername = username.trim();
  const normalizedEmail = email.trim().toLowerCase();
  const existing = db.prepare(`
    SELECT id FROM users
    WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE
  `).get(normalizedUsername, normalizedEmail);
  if (existing) throw new Error('Username or email already taken.');

  const hash = hashPassword(password);
  let result: Database.RunResult;
  try {
    result = db.prepare(
      // feed_exposure is explicitly 'everyone' so new users immediately see the full
      // public community feed rather than an empty "extended" (follows-only) feed.
      "INSERT INTO users (username, display_name, email, password_hash, feed_exposure) VALUES (?, ?, ?, ?, 'everyone')"
    ).run(normalizedUsername, displayName, normalizedEmail, hash);
  } catch (err: any) {
    if (String(err?.code || '').startsWith('SQLITE_CONSTRAINT')) {
      throw new Error('Username or email already taken.');
    }
    throw err;
  }

  return getUserById(result.lastInsertRowid as number)!;
}
