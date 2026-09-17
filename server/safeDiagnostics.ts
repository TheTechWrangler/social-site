export type DiagnosticSeverity = 'info' | 'warn' | 'error' | 'fatal';

const SUBSYSTEMS = new Set([
  'auth', 'email', 'feed', 'follows', 'groups', 'posts', 'rss', 'server',
  'session', 'telemetry', 'uploads', 'world-comments',
]);
const CODES = new Set([
  'AUTH_OPERATION_FAILED',
  'AUTH_REGISTER_FAILED',
  'AUTH_LOGIN_FAILED',
  'AUTH_PASSWORD_CHANGE_FAILED',
  'AUTH_PASSWORD_RESET_FAILED',
  'AUTH_EMAIL_VERIFICATION_FAILED',
  'AUTH_OAUTH_HANDOFF_FAILED',
  'AUTH_LOGOUT_FAILED',
  'EMAIL_PROVIDER_REJECTED',
  'EMAIL_SEND_FAILED',
  'FEED_LOAD_FAILED',
  'FEED_REPLENISH_FAILED',
  'FOLLOW_CREATE_FAILED',
  'GROUP_DELETE_FAILED',
  'GROUP_OWNERSHIP_TRANSFER_FAILED',
  'POST_CREATE_FAILED',
  'RSS_BATCH_COMPLETED_WITH_ERRORS',
  'RSS_REFRESH_FAILED',
  'RSS_RETENTION_CLEANUP_FAILED',
  'SERVER_CORS_CONFIG_INVALID',
  'SERVER_UNCAUGHT_EXCEPTION',
  'SERVER_UNHANDLED_REJECTION',
  'SERVER_REQUEST_FAILED',
  'SESSION_CLEANUP_FAILED',
  'TELEMETRY_CLEANUP_FAILED',
  'TOKEN_RETENTION_CLEANUP_FAILED',
  'EMAIL_VERIFICATION_RETENTION_CLEANUP_FAILED',
  'UPLOAD_ATTACH_FAILED',
  'UPLOAD_AVATAR_FAILED',
  'UPLOAD_IMAGE_FAILED',
  'UPLOAD_VALIDATION_FAILED',
  'UPLOAD_VIDEO_ATTACH_FAILED',
  'USAGE_EVENT_WRITE_FAILED',
  'WORLD_COMMENTS_CREATE_FAILED',
  'WORLD_COMMENTS_DELETE_FAILED',
  'WORLD_COMMENTS_LOAD_FAILED',
]);
const SAFE_CONTEXT_KEYS = new Set(['errorCount', 'itemsInserted', 'sourcesChecked']);

export interface DiagnosticInput {
  subsystem: string;
  severity: DiagnosticSeverity;
  code: string;
  httpStatus?: number;
  context?: Record<string, unknown>;
}

export interface SafeDiagnostic {
  subsystem: string;
  severity: DiagnosticSeverity;
  code: string;
  httpStatus?: number;
  context?: Record<string, number | boolean>;
}

/** Drops unapproved strings and objects, including Error/request objects and paths. */
export function serializeDiagnostic(input: DiagnosticInput): SafeDiagnostic {
  const output: SafeDiagnostic = {
    subsystem: SUBSYSTEMS.has(input.subsystem) ? input.subsystem : 'server',
    severity: ['info', 'warn', 'error', 'fatal'].includes(input.severity) ? input.severity : 'error',
    code: CODES.has(input.code) ? input.code : 'SERVER_REQUEST_FAILED',
  };
  if (Number.isInteger(input.httpStatus) && input.httpStatus! >= 100 && input.httpStatus! <= 599) output.httpStatus = input.httpStatus;
  const context: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(input.context || {})) {
    if (!SAFE_CONTEXT_KEYS.has(key)) continue;
    if (typeof value === 'boolean') context[key] = value;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
      context[key] = Math.min(value, 1_000_000);
    }
  }
  if (Object.keys(context).length) output.context = context;
  return output;
}

export function logSafeDiagnostic(input: DiagnosticInput): void {
  const diagnostic = serializeDiagnostic(input);
  const line = `[diagnostic] ${JSON.stringify(diagnostic)}`;
  if (diagnostic.severity === 'info') console.log(line);
  else if (diagnostic.severity === 'warn') console.warn(line);
  else console.error(line);
}
