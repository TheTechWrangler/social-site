/**
 * authEvents.ts — append-only auth/account event logger.
 *
 * Rules:
 * - NEVER log passwords, tokens, OAuth secrets, or session cookies.
 * - Keep reason codes generic/safe (no "email not found" distinction).
 * - Logging failures must never crash the request handler.
 */
import { getDb } from './database.js';
import { isIP } from 'node:net';
import { logSafeDiagnostic } from './safeDiagnostics.js';

export type AuthEventType =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'register_success'
  | 'oauth_success'
  | 'oauth_failure'
  | 'provider_account_reclaimed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'admin_ban'
  | 'admin_unban'
  | 'admin_role_change'
  | 'admin_delete_user'
  | 'admin_verify_user'
  | 'admin_unverify_user'
  | 'admin_password_reset_token'
  | 'admin_backup_run'
  | 'admin_upload_backup_run'
  | 'admin_hide_post'
  | 'admin_unhide_post'
  | 'admin_self_ban_blocked'
  | 'admin_last_admin_ban_blocked'
  | 'admin_last_admin_demote_blocked'
  | 'admin_report_update'
  | 'admin_game_server_create'
  | 'admin_game_server_update'
  | 'admin_game_server_delete'
  | 'admin_rss_source_add'
  | 'admin_rss_source_update'
  | 'admin_rss_source_fetch'
  | 'email_verification_sent'
  | 'email_verification_completed'
  | 'email_verification_resent';

export interface LogEventParams {
  eventType: AuthEventType;
  userId?: number | null;
  success?: boolean;
  /** Safe reason code — no PII, no secret detail. */
  reason?: string;
  ip?: string;
  userAgent?: string;
  adminActorId?: number | null;
  targetUserId?: number | null;
  /** Small event-specific context. The persistence boundary applies an allowlist. */
  meta?: Record<string, string | number | boolean>;
}

const EVENT_TYPES = new Set<AuthEventType>([
  'login_success', 'login_failure', 'logout', 'register_success', 'oauth_success',
  'oauth_failure', 'provider_account_reclaimed', 'password_reset_requested',
  'password_reset_completed', 'admin_ban', 'admin_unban', 'admin_role_change',
  'admin_delete_user', 'admin_verify_user', 'admin_unverify_user',
  'admin_password_reset_token', 'admin_backup_run', 'admin_upload_backup_run',
  'admin_hide_post', 'admin_unhide_post', 'admin_self_ban_blocked',
  'admin_last_admin_ban_blocked', 'admin_last_admin_demote_blocked',
  'admin_report_update', 'admin_game_server_create', 'admin_game_server_update',
  'admin_game_server_delete', 'admin_rss_source_add', 'admin_rss_source_update',
  'admin_rss_source_fetch', 'email_verification_sent',
  'email_verification_completed', 'email_verification_resent',
]);

const REASONS: Partial<Record<AuthEventType, ReadonlySet<string>>> = {
  login_failure: new Set(['INVALID_CREDENTIALS', 'ACCOUNT_BANNED']),
  oauth_failure: new Set(['OAUTH_PROVIDER_ERROR', 'ACCOUNT_UNAVAILABLE']),
  admin_self_ban_blocked: new Set(['self_ban_blocked']),
  admin_last_admin_ban_blocked: new Set(['last_active_admin']),
  admin_last_admin_demote_blocked: new Set(['last_active_admin', 'self_demotion_blocked']),
};

function safePositiveInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

/** Enforces per-event metadata allowlists before auth telemetry reaches SQLite. */
export function sanitizeAuthEventMetadata(
  eventType: AuthEventType,
  metadata: LogEventParams['meta'],
): Record<string, string | number | boolean> | undefined {
  if (!metadata) return undefined;
  const output: Record<string, string | number | boolean> = {};

  if (eventType === 'provider_account_reclaimed' && ['google', 'steam'].includes(String(metadata.provider))) {
    output.provider = String(metadata.provider);
  }
  if (eventType === 'email_verification_sent') {
    if (metadata.triggered_by === 'register') output.triggered_by = 'register';
    if (typeof metadata.email_configured === 'boolean') output.email_configured = metadata.email_configured;
  }
  if (eventType === 'password_reset_requested') {
    if (typeof metadata.email_configured === 'boolean') output.email_configured = metadata.email_configured;
    if (typeof metadata.self_serve === 'boolean') output.self_serve = metadata.self_serve;
  }
  if (eventType === 'email_verification_resent' && typeof metadata.email_configured === 'boolean') {
    output.email_configured = metadata.email_configured;
  }

  const idRules: Partial<Record<AuthEventType, string>> = {
    admin_hide_post: 'postId', admin_unhide_post: 'postId', admin_report_update: 'reportId',
    admin_game_server_create: 'serverId', admin_game_server_update: 'serverId',
    admin_game_server_delete: 'serverId', admin_rss_source_add: 'sourceId',
    admin_rss_source_update: 'sourceId', admin_rss_source_fetch: 'sourceId',
  };
  const idKey = idRules[eventType];
  const id = idKey ? safePositiveInteger(metadata[idKey]) : undefined;
  if (idKey && id !== undefined) output[idKey] = id;

  if (eventType === 'admin_report_update' && ['open', 'dismissed', 'resolved'].includes(String(metadata.status))) {
    output.status = String(metadata.status);
  }
  if (eventType === 'admin_role_change' && ['user', 'mod', 'admin'].includes(String(metadata.newRole))) {
    output.newRole = String(metadata.newRole);
  }
  if (eventType === 'admin_rss_source_fetch' && Number.isSafeInteger(metadata.itemsInserted) && Number(metadata.itemsInserted) >= 0) {
    output.itemsInserted = Math.min(Number(metadata.itemsInserted), 10_000);
  }

  return Object.keys(output).length ? output : undefined;
}

function sanitizeIp(value: unknown): string {
  if (typeof value !== 'string') return '';
  const candidate = value.replace(/^::ffff:/, '');
  return candidate.length <= 45 && isIP(candidate) ? candidate : '';
}

function sanitizeUserAgent(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
}

export function logAuthEvent(params: LogEventParams): void {
  try {
    if (!EVENT_TYPES.has(params.eventType)) return;
    const metadata = sanitizeAuthEventMetadata(params.eventType, params.meta);
    getDb().prepare(`
      INSERT INTO auth_events
        (user_id, event_type, success, reason, ip_address, user_agent,
         admin_actor_id, target_user_id, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      safePositiveInteger(params.userId) ?? null,
      params.eventType,
      params.success !== false ? 1 : 0,
      params.reason && REASONS[params.eventType]?.has(params.reason) ? params.reason : '',
      sanitizeIp(params.ip),
      sanitizeUserAgent(params.userAgent),
      safePositiveInteger(params.adminActorId) ?? null,
      safePositiveInteger(params.targetUserId) ?? null,
      metadata ? JSON.stringify(metadata) : '',
    );
  } catch {
    // Never let logging crash the caller.
    logSafeDiagnostic({ subsystem: 'telemetry', severity: 'error', code: 'AUTH_OPERATION_FAILED' });
  }
}

/** Extracts the real client IP, respecting TRUST_PROXY=1 (Express sets req.ip). */
export function getClientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return sanitizeIp(raw);
}
