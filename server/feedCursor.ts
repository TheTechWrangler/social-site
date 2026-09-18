import { RequestValidationError } from './requestValidation.js';

export type FeedCursorKind = 'posts' | 'external';

export interface FeedCursorKey {
  time: number;
  id: number;
}

interface EncodedFeedCursor {
  v: 1;
  k: FeedCursorKind;
  c: string;
  t: number;
  i: number;
}

const MAX_CURSOR_LENGTH = 256;
const MAX_JULIAN_DAY = 5_373_484.499999;

export function encodeFeedCursor(
  kind: FeedCursorKind,
  context: string,
  key: FeedCursorKey,
): string {
  const payload: EncodedFeedCursor = { v: 1, k: kind, c: context, t: key.time, i: key.id };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeFeedCursor(
  value: unknown,
  kind: FeedCursorKind,
  context: string,
): FeedCursorKey | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR_LENGTH
    || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RequestValidationError('cursor is invalid.');
  }
  let parsed: unknown;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.byteLength(decoded, 'utf8') > MAX_CURSOR_LENGTH) throw new Error('oversized');
    parsed = JSON.parse(decoded);
  } catch {
    throw new RequestValidationError('cursor is invalid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RequestValidationError('cursor is invalid.');
  }
  const candidate = parsed as Partial<EncodedFeedCursor>;
  const keys = Object.keys(candidate).sort().join(',');
  const timeValid = typeof candidate.t === 'number' && Number.isFinite(candidate.t)
    && candidate.t >= 0 && candidate.t <= MAX_JULIAN_DAY;
  if (keys !== 'c,i,k,t,v' || candidate.v !== 1 || candidate.k !== kind || candidate.c !== context
    || !timeValid || !Number.isSafeInteger(candidate.i) || Number(candidate.i) <= 0) {
    throw new RequestValidationError('cursor is invalid.');
  }
  return { time: candidate.t!, id: Number(candidate.i) };
}
