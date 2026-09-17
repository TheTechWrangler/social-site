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
import { canonicalTelemetryRoute } from '../shared/telemetry.js';
import { logSafeDiagnostic } from './safeDiagnostics.js';

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

const EVENT_TYPES = new Set<UsageEventType>([
  'page_view', 'login_success', 'logout', 'register_success', 'post_created',
  'comment_created', 'like_created', 'repost_created', 'group_created',
  'group_ownership_transferred', 'group_deleted', 'message_sent',
  'upload_started', 'upload_completed', 'upload_failed', 'feed_refreshed',
  'rss_replenished', 'client_error',
]);
const FEATURE_AREAS = new Set(['feed', 'world', 'games', 'groups', 'social', 'messages', 'account', 'admin', 'profile', 'other']);
const ERROR_CODES = new Set(['SERVER_ERROR', 'UNHANDLED_ERROR']);

function safeMetadata(eventType: UsageEventType, metadata: LogUsageParams['metadata']): Record<string, number> | undefined {
  if (eventType !== 'rss_replenished'
    || !Number.isSafeInteger(metadata?.sourcesChecked)
    || Number(metadata!.sourcesChecked) < 0) return undefined;
  return { sourcesChecked: Math.min(Number(metadata!.sourcesChecked), 20) };
}

function safeUserId(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

export function logUsage(params: LogUsageParams): void {
  try {
    if (!EVENT_TYPES.has(params.eventType)) return;
    const db = getDb();
    const metadata = safeMetadata(params.eventType, params.metadata);
    db.prepare(`
      INSERT INTO usage_events (event_type, user_id, route, feature_area, success, error_code, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.eventType,
      safeUserId(params.userId),
      params.route === undefined ? null : canonicalTelemetryRoute(params.route),
      params.featureArea && FEATURE_AREAS.has(params.featureArea) ? params.featureArea : null,
      params.success === false ? 0 : 1,
      params.errorCode && ERROR_CODES.has(params.errorCode) ? params.errorCode : null,
      metadata ? JSON.stringify(metadata) : null,
    );
  } catch {
    logSafeDiagnostic({ subsystem: 'telemetry', severity: 'error', code: 'USAGE_EVENT_WRITE_FAILED' });
  }
}
