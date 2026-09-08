const LEGACY_SQLITE_UTC =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d{1,3})?$/;
const EXPLICIT_OFFSET_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i;

function hasValidCalendarFields(value: string): boolean {
  const fields = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/,
  );
  if (!fields) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = fields;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return (
    calendarDate.getUTCFullYear() === year &&
    calendarDate.getUTCMonth() === month - 1 &&
    calendarDate.getUTCDate() === day
  );
}

/**
 * Parse token timestamps only when their timezone is unambiguous.
 * Legacy SQLite UTC values ("YYYY-MM-DD HH:MM:SS") remain supported by
 * explicitly treating them as UTC rather than the host's local timezone.
 */
export function parseTokenExpiryUtc(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!hasValidCalendarFields(trimmed)) return null;
  const legacy = trimmed.match(LEGACY_SQLITE_UTC);
  const normalized = legacy
    ? `${legacy[1]}T${legacy[2]}${legacy[3] || ''}Z`
    : EXPLICIT_OFFSET_TIMESTAMP.test(trimmed)
      ? trimmed
      : null;
  if (!normalized) return null;

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** A token is expired at its exact boundary; it must expire strictly after now. */
export function isTokenUnexpired(value: unknown, nowMs = Date.now()): boolean {
  const expiresAt = parseTokenExpiryUtc(value);
  return expiresAt !== null && expiresAt > nowMs;
}

export function utcExpiryFromNow(ttlHours: number, nowMs = Date.now()): string {
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    throw new Error('Token TTL must be a positive number of hours.');
  }
  return new Date(nowMs + ttlHours * 60 * 60 * 1000).toISOString();
}
