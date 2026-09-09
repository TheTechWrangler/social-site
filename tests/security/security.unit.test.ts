import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRouter, Link, Routes } from 'react-router-dom';
import {
  OAUTH_STATE_TTL_MS,
  consumeGoogleOAuthState,
  consumeSteamLoginIntent,
  issueGoogleOAuthState,
  issueSteamLoginIntent,
  type OAuthStateSession,
} from '../../server/oauthState.js';
import {
  isTokenUnexpired,
  parseTokenExpiryUtc,
  utcExpiryFromNow,
} from '../../server/tokenExpiry.js';
import {
  isStoredSessionUnexpired,
  parseStoredSessionExpiry,
  sessionExpiryEpochMs,
} from '../../server/sessionExpiry.js';
import { destroyBrowserSession } from '../../server/browserSession.js';
import { RouteRequestGate, routeFailureState, routeStateForKey } from '../../src/routeLoadState.js';

test('route load failures distinguish unavailable objects from retryable failures', () => {
  assert.equal(routeFailureState({ status: 404 }), 'unavailable');
  assert.equal(routeFailureState({ status: 403 }), 'unavailable');
  assert.equal(routeFailureState({ status: 429 }), 'error');
  assert.equal(routeFailureState({ status: 500 }), 'error');
  assert.equal(routeFailureState(new TypeError('network failed')), 'error');
});

test('route-key changes hide prior loaded and unavailable states immediately', () => {
  assert.equal(routeStateForKey('valid', 'valid', 'loaded'), 'loaded');
  assert.equal(routeStateForKey('missing', 'valid', 'loaded'), 'loading');
  assert.equal(routeStateForKey('missing', 'missing', 'unavailable'), 'unavailable');
  assert.equal(routeStateForKey('valid', 'missing', 'unavailable'), 'loading');
  assert.equal(routeStateForKey('valid', 'valid', 'error'), 'error');
});

test('route request generations reject obsolete and unmounted completions', async () => {
  const gate = new RouteRequestGate();
  const commits: string[] = [];
  let releaseOld!: (value: string) => void;
  let releaseNew!: (value: string) => void;
  const oldResponse = new Promise<string>(resolve => { releaseOld = resolve; });
  const newResponse = new Promise<string>(resolve => { releaseNew = resolve; });

  const oldIsCurrent = gate.begin();
  const oldCommit = oldResponse.then(value => {
    if (oldIsCurrent()) commits.push(value);
  });
  const newIsCurrent = gate.begin();
  const newCommit = newResponse.then(value => {
    if (newIsCurrent()) commits.push(value);
  });

  releaseNew('new route');
  await newCommit;
  releaseOld('old route');
  await oldCommit;
  assert.deepEqual(commits, ['new route']);

  const retryIsCurrent = gate.begin();
  assert.equal(retryIsCurrent(), true);
  gate.invalidate();
  assert.equal(retryIsCurrent(), false);
});

test('Google OAuth state accepts once and rejects replay', () => {
  const now = 1_800_000_000_000;
  const session: OAuthStateSession = {};
  const state = issueGoogleOAuthState(session, now, 'a'.repeat(43));

  assert.deepEqual(consumeGoogleOAuthState(session, state, now + 1), { ok: true });
  assert.deepEqual(consumeGoogleOAuthState(session, state, now + 2), {
    ok: false,
    reason: 'missing',
  });
});

test('Google OAuth state rejects missing, mismatch, malformed, and expiry boundary', () => {
  const now = 1_800_000_000_000;

  assert.deepEqual(consumeGoogleOAuthState({}, undefined, now), {
    ok: false,
    reason: 'missing',
  });

  const mismatch: OAuthStateSession = {};
  issueGoogleOAuthState(mismatch, now, 'a'.repeat(43));
  assert.deepEqual(consumeGoogleOAuthState(mismatch, 'b'.repeat(43), now + 1), {
    ok: false,
    reason: 'mismatch',
  });
  assert.equal(mismatch.googleOAuthState, undefined);

  const malformed: OAuthStateSession = {
    googleOAuthState: { value: 'short', issuedAt: now },
  };
  assert.deepEqual(consumeGoogleOAuthState(malformed, 'short', now + 1), {
    ok: false,
    reason: 'malformed',
  });

  const boundary: OAuthStateSession = {};
  issueGoogleOAuthState(boundary, now, 'c'.repeat(43));
  assert.deepEqual(
    consumeGoogleOAuthState(boundary, 'c'.repeat(43), now + OAUTH_STATE_TTL_MS),
    { ok: false, reason: 'expired' },
  );
});

test('Steam login intent is session-bound, expiring, and one-shot', () => {
  const now = 1_800_000_000_000;
  const session: OAuthStateSession = {};
  issueSteamLoginIntent(session, now);
  assert.equal(consumeSteamLoginIntent(session, now + 1), true);
  assert.equal(consumeSteamLoginIntent(session, now + 2), false);

  issueSteamLoginIntent(session, now);
  assert.equal(consumeSteamLoginIntent(session, now + OAUTH_STATE_TTL_MS), false);
});

test('token expiry accepts new ISO UTC and legacy SQLite UTC timestamps', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  assert.equal(isTokenUnexpired('2026-09-08T12:00:01.000Z', now), true);
  assert.equal(isTokenUnexpired('2026-09-08 12:00:01', now), true);
  assert.equal(isTokenUnexpired('2026-09-08T07:00:01-05:00', now), true);
});

test('token expiry rejects expired, boundary, timezone-less ISO, and malformed values', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  assert.equal(isTokenUnexpired('2026-09-08T11:59:59.999Z', now), false);
  assert.equal(isTokenUnexpired('2026-09-08T12:00:00.000Z', now), false);
  assert.equal(isTokenUnexpired('2026-09-08T12:00:01', now), false);
  assert.equal(isTokenUnexpired('not-a-timestamp', now), false);
  assert.equal(isTokenUnexpired(null, now), false);
  assert.equal(parseTokenExpiryUtc('2026-02-30 12:00:00'), null);
});

test('new token expiries are explicit UTC and do not extend the requested TTL', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  const expires = utcExpiryFromNow(1, now);
  assert.equal(expires, '2026-09-08T13:00:00.000Z');
  assert.equal(parseTokenExpiryUtc(expires), now + 60 * 60 * 1000);
});

test('session expiry uses epoch milliseconds with exact-boundary and legacy handling', () => {
  const beforeMidnight = Date.UTC(2026, 8, 8, 23, 59, 59, 999);
  const midnight = Date.UTC(2026, 8, 9, 0, 0, 0, 0);
  assert.equal(isStoredSessionUnexpired(midnight, beforeMidnight), true);
  assert.equal(isStoredSessionUnexpired(midnight, midnight), false);
  assert.equal(isStoredSessionUnexpired(midnight, midnight + 1), false);
  assert.equal(parseStoredSessionExpiry(String(midnight)), midnight);
  assert.equal(parseStoredSessionExpiry('2026-09-09T00:00:00.000Z'), midnight);
  assert.equal(parseStoredSessionExpiry('2026-09-09 00:00:00'), midnight);
  assert.equal(parseStoredSessionExpiry('2026-09-09T00:00:00'), null);
  assert.equal(parseStoredSessionExpiry('not-a-session-expiry'), null);
  assert.equal(parseStoredSessionExpiry(0), null);
});

test('session touch expiry preserves explicit expiry and slides max-age fallback', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  const absolute = now + 30_000;
  assert.equal(sessionExpiryEpochMs({ cookie: { expires: new Date(absolute), originalMaxAge: 60_000 } }, now), absolute);
  assert.equal(sessionExpiryEpochMs({ cookie: { expires: new Date(absolute).toISOString(), originalMaxAge: 60_000 } }, now), absolute);
  assert.equal(sessionExpiryEpochMs({ cookie: { originalMaxAge: 60_000 } }, now), now + 60_000);
  assert.equal(sessionExpiryEpochMs({ cookie: { originalMaxAge: 60_000 } }, now + 1), now + 60_001);
});

test('browser-session teardown reports Passport and store failures', async () => {
  let destroyCalled = false;
  await assert.rejects(destroyBrowserSession({
    logout: (done: (err: Error) => void) => done(new Error('passport failure')),
    session: { destroy: () => { destroyCalled = true; } },
  } as any), /passport failure/);
  assert.equal(destroyCalled, false);

  await assert.rejects(destroyBrowserSession({
    logout: (done: (err: null) => void) => done(null),
    session: { destroy: (done: (err: Error) => void) => done(new Error('store failure')) },
  } as any), /store failure/);

  const successful: any = {
    user: { id: 1 },
    logout: (done: (err: null) => void) => done(null),
    session: { destroy: (done: (err: null) => void) => done(null) },
  };
  await destroyBrowserSession(successful);
  assert.equal(successful.user, undefined);
});

test('React Router v7 retains the declarative APIs used by RefugeCloud', () => {
  assert.equal(typeof BrowserRouter, 'function');
  assert.equal(typeof Link, 'object');
  assert.equal(typeof Routes, 'function');
});
