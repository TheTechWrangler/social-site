import { randomBytes, timingSafeEqual } from 'node:crypto';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

interface GoogleOAuthStateRecord {
  value: string;
  issuedAt: number;
}

interface SteamLoginIntentRecord {
  issuedAt: number;
}

export interface OAuthStateSession {
  googleOAuthState?: GoogleOAuthStateRecord;
  steamLoginIntent?: SteamLoginIntentRecord;
}

export type OAuthStateResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' };

function isFreshTimestamp(issuedAt: unknown, now: number): boolean {
  return (
    typeof issuedAt === 'number' &&
    Number.isFinite(issuedAt) &&
    issuedAt <= now &&
    now - issuedAt < OAUTH_STATE_TTL_MS
  );
}

export function issueGoogleOAuthState(
  session: OAuthStateSession,
  now = Date.now(),
  randomState = randomBytes(32).toString('base64url'),
): string {
  session.googleOAuthState = { value: randomState, issuedAt: now };
  return randomState;
}

/**
 * Consume before validating so missing, mismatched, expired, and successful
 * callbacks are all one-shot and cannot be replayed.
 */
export function consumeGoogleOAuthState(
  session: OAuthStateSession | undefined,
  providedState: unknown,
  now = Date.now(),
): OAuthStateResult {
  const expected = session?.googleOAuthState;
  if (session) delete session.googleOAuthState;

  if (!expected) return { ok: false, reason: 'missing' };
  if (
    typeof expected.value !== 'string' ||
    expected.value.length < 32 ||
    !isFreshTimestamp(expected.issuedAt, now)
  ) {
    return {
      ok: false,
      reason: isFreshTimestamp(expected.issuedAt, now) ? 'malformed' : 'expired',
    };
  }
  if (typeof providedState !== 'string' || providedState.length !== expected.value.length) {
    return { ok: false, reason: 'mismatch' };
  }

  const expectedBytes = Buffer.from(expected.value);
  const providedBytes = Buffer.from(providedState);
  if (
    expectedBytes.length !== providedBytes.length ||
    !timingSafeEqual(expectedBytes, providedBytes)
  ) {
    return { ok: false, reason: 'mismatch' };
  }

  return { ok: true };
}

/**
 * Steam OpenID 2.0 has no OAuth state parameter. Its signed return_to and
 * response_nonce validation are supplemented with a one-shot session intent,
 * which prevents an unsolicited assertion from logging a browser into an
 * attacker's account.
 */
export function issueSteamLoginIntent(session: OAuthStateSession, now = Date.now()): void {
  session.steamLoginIntent = { issuedAt: now };
}

export function consumeSteamLoginIntent(
  session: OAuthStateSession | undefined,
  now = Date.now(),
): boolean {
  const intent = session?.steamLoginIntent;
  if (session) delete session.steamLoginIntent;
  return !!intent && isFreshTimestamp(intent.issuedAt, now);
}
