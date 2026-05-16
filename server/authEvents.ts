/**
 * authEvents.ts — append-only auth/account event logger.
 *
 * Rules:
 * - NEVER log passwords, tokens, OAuth secrets, or session cookies.
 * - Keep reason codes generic/safe (no "email not found" distinction).
 * - Logging failures must never crash the request handler.
 */
import { getDb } from './database.js';

export type AuthEventType =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'register_success'
  | 'oauth_success'
  | 'oauth_failure'
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
  /** Small safe key/value context (e.g. username, provider). No secrets. */
  meta?: Record<string, string | number | boolean>;
}

export function logAuthEvent(params: LogEventParams): void {
  try {
    getDb().prepare(`
      INSERT INTO auth_events
        (user_id, event_type, success, reason, ip_address, user_agent,
         admin_actor_id, target_user_id, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.userId ?? null,
      params.eventType,
      params.success !== false ? 1 : 0,
      params.reason ?? '',
      params.ip ?? '',
      (params.userAgent ?? '').slice(0, 500),
      params.adminActorId ?? null,
      params.targetUserId ?? null,
      params.meta ? JSON.stringify(params.meta) : '',
    );
  } catch (e) {
    // Never let logging crash the caller.
    console.error('[authEvents] Failed to log event:', (e as Error).message);
  }
}

/** Extracts the real client IP, respecting TRUST_PROXY=1 (Express sets req.ip). */
export function getClientIp(req: { ip?: string; socket?: { remoteAddress?: string } }): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return raw.replace('::ffff:', ''); // strip IPv4-mapped IPv6 prefix
}
