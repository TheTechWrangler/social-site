import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from './database.js';

// Production startup check is in server/index.ts. This fallback is dev-only.
const JWT_SECRET = process.env.JWT_SECRET || 'social-site-dev-secret-change-in-production';
const TOKEN_EXPIRY = '7d';

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
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash);
}

export function generateToken(user: AuthUser): string {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
      is_verified: user.is_verified,
      isVerified: !!user.is_verified,
      banned: user.banned,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

export function verifyToken(token: string): { id: number; username: string; role: string; is_verified?: number; isVerified?: boolean; banned?: number } | null {
  try {
    return jwt.verify(token, JWT_SECRET) as { id: number; username: string; role: string; is_verified?: number; isVerified?: boolean; banned?: number };
  } catch {
    return null;
  }
}

export function getUserById(id: number): AuthUser | null {
  const row = getDb().prepare(
    'SELECT id, username, display_name, email, role, banned, is_verified, profile_visibility, feed_exposure, world_home_injection, game_discovery_enabled, dm_privacy FROM users WHERE id = ?'
  ).get(id) as AuthUser | undefined;
  return row ?? null;
}

export function getUserByUsername(username: string): (AuthUser & { password_hash: string }) | null {
  const row = getDb().prepare(
    'SELECT * FROM users WHERE username = ?'
  ).get(username) as any;
  return row ?? null;
}

export function registerUser(username: string, displayName: string, email: string, password: string): AuthUser {
  const existing = getDb().prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) throw new Error('Username or email already taken.');

  const hash = hashPassword(password);
  const result = getDb().prepare(
    'INSERT INTO users (username, display_name, email, password_hash) VALUES (?, ?, ?, ?)'
  ).run(username, displayName, email, hash);

  return getUserById(result.lastInsertRowid as number)!;
}
