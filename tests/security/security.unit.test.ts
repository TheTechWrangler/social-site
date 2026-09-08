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

test('React Router v7 retains the declarative APIs used by RefugeCloud', () => {
  assert.equal(typeof BrowserRouter, 'function');
  assert.equal(typeof Link, 'object');
  assert.equal(typeof Routes, 'function');
});
