/**
 * usageEvents.ts — append-only usage/analytics event logger.
 *
 * Privacy rules (hard):
 * - NEVER log message content, post/comment bodies, passwords, tokens.
 * - NEVER log full query strings with private params.
 * - Store only: event type, user_id (nullable), sanitized route,
 *   feature area, success boolean, generic error code, timestamp.
 * - Logging failures must never crash the request handler.
 */
import { getDb } from './database.js';

export type UsageEventType =
  | 'page_view'
  | 'login_success'
  | 'logout'
  | 'register_success'
  | 'post_created'
  | 'comment_created'
  | 'like_created'
  | 'repost_created'
  | 'group_created'
  | 'group_ownership_transferred'
  | 'group_deleted'
  | 'message_sent'
  | 'upload_started'
  | 'upload_completed'
  | 'upload_failed'
  | 'feed_refreshed'
  | 'rss_replenished'
  | 'client_error';

export interface LogUsageParams {
  eventType: UsageEventType;
  userId?: number | null;
  route?: string;
  featureArea?: string;
  success?: boolean;
  errorCode?: string;
  metadata?: Record<string, string | number | boolean>;
}

export function logUsage(params: LogUsageParams): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO usage_events (event_type, user_id, route, feature_area, success, error_code, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.eventType,
      params.userId ?? null,
      params.route ?? null,
      params.featureArea ?? null,
      params.success === false ? 0 : 1,
      params.errorCode ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
    );
  } catch (e) {
    console.error('[usageEvents] Failed to log:', (e as Error).message);
  }
}
