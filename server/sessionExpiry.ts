import { parseTokenExpiryUtc } from './tokenExpiry.js';

const DEFAULT_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Parse new epoch-millisecond values and unambiguous legacy UTC timestamps. */
export function parseStoredSessionExpiry(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\d{13}$/.test(trimmed)) {
    const epochMs = Number(trimmed);
    return Number.isSafeInteger(epochMs) && epochMs > 0 ? epochMs : null;
  }
  return parseTokenExpiryUtc(trimmed);
}

export function isStoredSessionUnexpired(value: unknown, nowMs = Date.now()): boolean {
  const expiresAtMs = parseStoredSessionExpiry(value);
  return expiresAtMs !== null && expiresAtMs > nowMs;
}

/** Preserve express-session's existing cookie-derived touch/lifetime behavior. */
export function sessionExpiryEpochMs(session: any, nowMs = Date.now()): number {
  const cookieExpires = session.cookie?.expires;
  const explicitExpiry = cookieExpires instanceof Date
    ? cookieExpires.getTime()
    : typeof cookieExpires === 'string'
      ? Date.parse(cookieExpires)
      : NaN;
  if (Number.isFinite(explicitExpiry)) return explicitExpiry;

  const configuredMaxAge = Number(session.cookie?.originalMaxAge);
  const maxAge = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0
    ? configuredMaxAge
    : DEFAULT_SESSION_MAX_AGE_MS;
  return nowMs + maxAge;
}
