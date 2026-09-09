import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as SteamStrategy } from 'passport-steam';
import { getDb } from './database.js';
import { generateToken, getUserById, type AuthUser } from './auth.js';
import { logAuthEvent, getClientIp } from './authEvents.js';
import { resolveProviderAccount } from './providerAccounts.js';

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3003';
const DEFAULT_PROD_WEB_URL = 'https://refugecloud.com';
const DEFAULT_DEV_WEB_URL = 'http://localhost:5174';
const PROD_WEB_ORIGINS = new Set(['https://refugecloud.com', 'https://www.refugecloud.com']);
let cachedSafeWebBaseUrl: string | null = null;

export function getSafeWebBaseUrl(): string {
  if (cachedSafeWebBaseUrl) return cachedSafeWebBaseUrl;
  const isProd = process.env.NODE_ENV === 'production';
  const fallback = isProd ? DEFAULT_PROD_WEB_URL : DEFAULT_DEV_WEB_URL;
  const raw = (process.env.WEB_BASE_URL || fallback).trim();
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('unsupported protocol');
    }
    if (isProd && !PROD_WEB_ORIGINS.has(parsed.origin)) {
      console.warn('[auth] WEB_BASE_URL is not an allowed production frontend origin; falling back to refugecloud.com.');
      cachedSafeWebBaseUrl = DEFAULT_PROD_WEB_URL;
      return cachedSafeWebBaseUrl;
    }
    cachedSafeWebBaseUrl = parsed.origin;
    return cachedSafeWebBaseUrl;
  } catch {
    console.warn('[auth] WEB_BASE_URL is invalid; using the default frontend origin.');
    cachedSafeWebBaseUrl = fallback;
    return cachedSafeWebBaseUrl;
  }
}

const WEB_URL = getSafeWebBaseUrl();

function toPassportUser(user: AuthUser): Express.User {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    is_verified: user.is_verified,
    profile_visibility: user.profile_visibility,
    game_discovery_enabled: user.game_discovery_enabled,
  };
}

function getActiveCanonicalUser(userId: number): AuthUser | null {
  const user = getUserById(userId);
  if (!user || user.banned) return null;
  return user;
}

// ─── Config Checks ───

export function isGoogleConfigured(): boolean {
  const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  return id.length > 10 && secret.length > 5 && id !== 'placeholder';
}

export function isSteamConfigured(): boolean {
  const apiKey = (process.env.STEAM_API_KEY || '').trim();
  const returnUrl = (process.env.STEAM_RETURN_URL || '').trim();
  return (
    apiKey.length > 5 &&
    apiKey !== 'placeholder' &&
    returnUrl.length > 10 &&
    returnUrl.startsWith('http')
  );
}

// ─── Configure Passport ───

export function configurePassport(): void {
  // Serialize minimal user info into session
  passport.serializeUser((user: any, done) => {
    done(null, { id: user.id });
  });

  passport.deserializeUser((obj: any, done) => {
    try {
      const userId = Number(obj?.id);
      if (!userId) { done(null, false); return; }
      const user = getActiveCanonicalUser(userId);
      if (!user) { done(null, false); return; }
      done(null, toPassportUser(user));
    } catch (err) {
      done(err as Error);
    }
  });

  // Google Strategy — always register name, verify config at runtime
  passport.use('google', new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID || 'placeholder',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'placeholder',
    callbackURL: process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/api/auth/google/callback`,
  }, (_accessToken, _refreshToken, profile, done) => {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return done(new Error('Google OAuth not configured. Set GOOGLE_CLIENT_ID.'));
    }
    try {
      const providerEmail = profile.emails?.find(candidate => candidate.verified);
      const email = providerEmail?.value || '';
      const verified = !!providerEmail;
      const displayName = profile.displayName || profile.name?.givenName || '';
      const avatarUrl = profile.photos?.[0]?.value || '';
      const result = resolveProviderAccount(getDb(), {
        provider: 'google',
        providerUserId: profile.id,
        email,
        emailVerified: verified,
        displayName,
        avatarUrl,
      });
      if (!result.ok) {
        console.warn(`[auth] Google account resolution refused: ${result.reason}`);
        done(null, false);
        return;
      }
      if (result.kind === 'reclaimed') {
        logAuthEvent({
          eventType: 'provider_account_reclaimed',
          userId: result.userId,
          meta: { provider: 'google' },
        });
      }
      const user = getActiveCanonicalUser(result.userId);
      done(null, user ? toPassportUser(user) : false);
    } catch (err) {
      done(err as Error);
    }
  }));
  if (isGoogleConfigured()) {
    console.log('[auth] Google OAuth: configured');
  } else {
    const missing = [];
    if (!process.env.GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
    if (!process.env.GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
    console.warn('[auth] Google OAuth: not configured' + (missing.length ? ` (missing: ${missing.join(', ')})` : ''));
  }

  // Steam Strategy — always register name
  passport.use('steam', new SteamStrategy({
    returnURL: process.env.STEAM_RETURN_URL || `${BASE_URL}/api/auth/steam/callback`,
    realm: process.env.STEAM_REALM || BASE_URL,
    apiKey: process.env.STEAM_API_KEY || 'placeholder',
  }, (_identifier: any, profile: any, done: any) => {
    if (!process.env.STEAM_RETURN_URL && !process.env.APP_BASE_URL) {
      return done(new Error('Steam OAuth not configured. Set STEAM_RETURN_URL.'));
    }
    try {
      const displayName = profile?.displayName || profile?.personaname || '';
      const avatarUrl = profile?.photos?.[2]?.value || profile?.avatarfull || '';
      const result = resolveProviderAccount(getDb(), {
        provider: 'steam',
        providerUserId: profile.id || _identifier,
        email: '',
        emailVerified: false,
        displayName,
        avatarUrl,
      });
      if (!result.ok) {
        console.warn(`[auth] Steam account resolution refused: ${result.reason}`);
        done(null, false);
        return;
      }
      const user = getActiveCanonicalUser(result.userId);
      done(null, user ? toPassportUser(user) : false);
    } catch (err) {
      done(err);
    }
  }));
  if (isSteamConfigured()) {
    console.log('[auth] Steam OpenID: configured');
  } else {
    const missing = [];
    if (!process.env.STEAM_API_KEY) missing.push('STEAM_API_KEY');
    if (!process.env.STEAM_RETURN_URL) missing.push('STEAM_RETURN_URL');
    console.warn('[auth] Steam OpenID: not configured' + (missing.length ? ` (missing: ${missing.join(', ')})` : ''));
  }
}

// ─── OAuth Callback Handler ───

export function handleOAuthCallback(req: any, res: any): void {
  const user = req.user as { id: number; username: string } | undefined;
  if (!user) {
    logAuthEvent({ eventType: 'oauth_failure', success: false, reason: 'OAUTH_PROVIDER_ERROR', ip: getClientIp(req), userAgent: req.headers?.['user-agent'] });
    res.redirect(`${WEB_URL}/login?error=oauth_failed`);
    return;
  }
  const canonicalUser = getActiveCanonicalUser(user.id);
  if (!canonicalUser) {
    logAuthEvent({ eventType: 'oauth_failure', userId: user.id, success: false, reason: 'ACCOUNT_UNAVAILABLE', ip: getClientIp(req), userAgent: req.headers?.['user-agent'] });
    res.redirect(`${WEB_URL}/login?error=oauth_failed`);
    return;
  }
  logAuthEvent({ eventType: 'oauth_success', userId: canonicalUser.id, ip: getClientIp(req), userAgent: req.headers?.['user-agent'], meta: { username: canonicalUser.username } });
  const token = generateToken(canonicalUser);

  // Store the JWT in the server-side session for one-time retrieval by the frontend.
  // This keeps the token out of the redirect URL, which would expose it via browser
  // history, proxy/server logs, and Referer headers.
  // The frontend calls GET /api/auth/oauth-token (with credentials) to claim it.
  req.session.oauthHandoffToken = token;
  req.session.oauthHandoffUsername = canonicalUser.username;
  req.session.save((err: any) => {
    if (err) {
      console.error('[auth] Failed to save OAuth handoff session:', err.message);
      res.redirect(`${WEB_URL}/login?error=oauth_failed`);
      return;
    }
    // Redirect to the frontend callback page — NO token in the URL.
    res.redirect(`${WEB_URL}/oauth/callback`);
  });
}
