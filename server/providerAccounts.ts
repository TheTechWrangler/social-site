import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { revokeAllApplicationSessionsInDb } from './authRevocation.js';

export type AuthProvider = 'google' | 'steam';

export interface ProviderIdentity {
  provider: AuthProvider;
  providerUserId: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string;
}

export type ProviderAccountResolution =
  | { ok: true; kind: 'existing' | 'created' | 'reclaimed'; userId: number; username: string }
  | { ok: false; reason:
      | 'invalid_identity'
      | 'account_banned'
      | 'ambiguous_email'
      | 'verified_account_requires_explicit_link'
      | 'unverified_account_has_existing_provider' };

interface ProviderUserRow {
  mapping_id: number;
  user_id: number;
  username: string;
  banned: number;
}

interface EmailUserRow {
  id: number;
  username: string;
  is_verified: number;
  banned: number;
}

function clean(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function normalizeEmail(value: unknown): string {
  return clean(value, 254).toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function uniqueSyntheticEmail(
  db: Database.Database,
  provider: AuthProvider,
  providerUserId: string,
): string {
  const digest = createHash('sha256').update(providerUserId).digest('hex').slice(0, 32);
  const base = `oauth-${digest}@${provider}.local`;
  if (!db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(base)) return base;
  let suffix = 1;
  let candidate = `oauth-${digest}-${suffix}@${provider}.local`;
  while (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(candidate)) {
    suffix += 1;
    candidate = `oauth-${digest}-${suffix}@${provider}.local`;
  }
  return candidate;
}

function findProviderUser(
  db: Database.Database,
  provider: AuthProvider,
  providerUserId: string,
): ProviderUserRow | undefined {
  return db.prepare(`
    SELECT p.id AS mapping_id, p.user_id, u.username, u.banned
    FROM user_auth_providers p
    JOIN users u ON u.id = p.user_id
    WHERE p.provider = ? AND p.provider_user_id = ?
  `).get(provider, providerUserId) as ProviderUserRow | undefined;
}

function uniqueUsername(db: Database.Database, suggestedName: string, provider: AuthProvider): string {
  const sanitized = suggestedName.replace(/[^a-zA-Z0-9_]/g, '_');
  const base = (sanitized || `${provider}_user`).slice(0, 20);
  let username = base;
  let suffix = 0;
  while (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(username)) {
    suffix += 1;
    username = `${base.slice(0, Math.max(1, 29 - String(suffix).length))}_${suffix}`;
  }
  return username;
}

function updateProviderMetadata(
  db: Database.Database,
  mappingId: number,
  identity: ProviderIdentity,
): void {
  db.prepare(`
    UPDATE user_auth_providers
    SET provider_email = CASE WHEN ? = 1 THEN ? ELSE provider_email END,
        provider_display_name = ?, provider_avatar_url = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    identity.emailVerified ? 1 : 0,
    identity.email,
    identity.displayName,
    identity.avatarUrl,
    mappingId,
  );
}

/**
 * Resolve a provider assertion without treating email equality as account control.
 * Existing provider IDs are authoritative. Verified Google email may reclaim only
 * a provider-free, unverified local account.
 */
export function resolveProviderAccount(
  db: Database.Database,
  rawIdentity: ProviderIdentity,
  nowMs = Date.now(),
): ProviderAccountResolution {
  const providerUserId = typeof rawIdentity.providerUserId === 'string'
    ? rawIdentity.providerUserId.trim()
    : '';
  const normalizedEmail = normalizeEmail(rawIdentity.email);
  const identity: ProviderIdentity = {
    provider: rawIdentity.provider,
    providerUserId,
    email: normalizedEmail,
    emailVerified: rawIdentity.emailVerified === true && isValidEmail(normalizedEmail),
    displayName: clean(rawIdentity.displayName, 200),
    avatarUrl: clean(rawIdentity.avatarUrl, 2048),
  };
  if (
    !['google', 'steam'].includes(identity.provider) ||
    !identity.providerUserId ||
    identity.providerUserId.length > 255
  ) {
    return { ok: false, reason: 'invalid_identity' };
  }

  const resolve = db.transaction((): ProviderAccountResolution => {
    const linked = findProviderUser(db, identity.provider, identity.providerUserId);
    if (linked) {
      if (linked.banned) return { ok: false, reason: 'account_banned' };
      updateProviderMetadata(db, linked.mapping_id, identity);
      return { ok: true, kind: 'existing', userId: linked.user_id, username: linked.username };
    }

    if (identity.provider === 'google' && identity.emailVerified && identity.email) {
      const emailUsers = db.prepare(`
        SELECT id, username, is_verified, banned FROM users
        WHERE email = ? COLLATE NOCASE LIMIT 2
      `).all(identity.email) as EmailUserRow[];
      if (emailUsers.length > 1) return { ok: false, reason: 'ambiguous_email' };

      const emailUser = emailUsers[0];
      if (emailUser) {
        if (emailUser.banned) return { ok: false, reason: 'account_banned' };
        if (emailUser.is_verified) {
          return { ok: false, reason: 'verified_account_requires_explicit_link' };
        }
        const providerCount = db.prepare(
          'SELECT COUNT(*) AS count FROM user_auth_providers WHERE user_id = ?',
        ).get(emailUser.id) as { count: number };
        if (providerCount.count !== 0) {
          return { ok: false, reason: 'unverified_account_has_existing_provider' };
        }

        const changedAt = new Date(nowMs).toISOString();
        const reclaimed = db.prepare(`
          UPDATE users
          SET password_hash = '', password_changed_at = ?, is_verified = 1, verified_at = ?
          WHERE id = ? AND is_verified = 0 AND banned = 0
        `).run(changedAt, changedAt, emailUser.id);
        if (reclaimed.changes !== 1) throw new Error('PROVIDER_RECLAMATION_RACE');

        db.prepare(`UPDATE email_verification_tokens
          SET used_at = COALESCE(used_at, ?) WHERE user_id = ?`)
          .run(changedAt, emailUser.id);
        db.prepare(`UPDATE password_reset_tokens
          SET used_at = COALESCE(used_at, ?) WHERE user_id = ?`)
          .run(changedAt, emailUser.id);
        revokeAllApplicationSessionsInDb(db, emailUser.id, nowMs);
        db.prepare(`
          INSERT INTO user_auth_providers
            (user_id, provider, provider_user_id, provider_email,
             provider_display_name, provider_avatar_url)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          emailUser.id, identity.provider, identity.providerUserId,
          identity.email, identity.displayName, identity.avatarUrl,
        );
        return { ok: true, kind: 'reclaimed', userId: emailUser.id, username: emailUser.username };
      }
    }

    const suggestedName = identity.displayName || identity.email.split('@')[0] || `${identity.provider}_user`;
    const username = uniqueUsername(db, suggestedName, identity.provider);
    const storedEmail = identity.emailVerified && identity.email
      ? identity.email
      : uniqueSyntheticEmail(db, identity.provider, identity.providerUserId);
    const result = db.prepare(`
      INSERT INTO users
        (username, display_name, email, password_hash, avatar_url,
         is_verified, verified_at, feed_exposure)
      VALUES (?, ?, ?, '', ?, 1, ?, 'everyone')
    `).run(
      username, identity.displayName || username, storedEmail,
      identity.avatarUrl, new Date(nowMs).toISOString(),
    );
    const userId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO user_auth_providers
        (user_id, provider, provider_user_id, provider_email,
         provider_display_name, provider_avatar_url)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      userId, identity.provider, identity.providerUserId,
      identity.emailVerified ? identity.email : '', identity.displayName, identity.avatarUrl,
    );
    return { ok: true, kind: 'created', userId, username };
  });

  return resolve.immediate();
}
