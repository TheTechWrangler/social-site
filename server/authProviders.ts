import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { Strategy as SteamStrategy } from 'passport-steam';
import { getDb } from './database.js';
import { generateToken } from './auth.js';
import { logAuthEvent, getClientIp } from './authEvents.js';

const BASE_URL = process.env.APP_BASE_URL || 'http://192.168.254.181:3003';
const WEB_URL = process.env.WEB_BASE_URL || 'http://192.168.254.181:5174';

// ─── Config Checks ───

export function isGoogleConfigured(): boolean {
  const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
  const secret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
  return id.length > 10 && secret.length > 5 && id !== 'placeholder';
}

export function isSteamConfigured(): boolean {
  const returnUrl = (process.env.STEAM_RETURN_URL || '').trim();
  return returnUrl.length > 10 && returnUrl.startsWith('http');
}

// ─── Find or Create User by Provider ───

function findOrCreateUser(provider: string, providerId: string, email: string, displayName: string, avatarUrl: string): { userId: number; username: string } {
  const db = getDb();

  // Check existing provider link
  const existing = db.prepare(
    'SELECT user_id FROM user_auth_providers WHERE provider = ? AND provider_user_id = ?'
  ).get(provider, providerId) as { user_id: number } | undefined;

  if (existing) {
    const user = db.prepare('SELECT username FROM users WHERE id = ?').get(existing.user_id) as any;
    return { userId: existing.user_id, username: user.username };
  }

  // Try to link by verified email (Google only)
  if (email && provider === 'google') {
    const emailUser = db.prepare('SELECT id, username FROM users WHERE email = ?').get(email.toLowerCase()) as any;
    if (emailUser) {
      // Link provider to existing account
      db.prepare(
        'INSERT OR IGNORE INTO user_auth_providers (user_id, provider, provider_user_id, provider_email, provider_display_name, provider_avatar_url) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(emailUser.id, provider, providerId, email, displayName, avatarUrl);
      return { userId: emailUser.id, username: emailUser.username };
    }
  }

  // Create new user
  const safeName = displayName || email?.split('@')[0] || `${provider}_user`;
  // Generate unique username
  let username = safeName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 20);
  let suffix = 0;
  while (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    suffix++;
    username = safeName.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 16) + '_' + suffix;
  }

  const result = db.prepare(
    'INSERT INTO users (username, display_name, email, password_hash, avatar_url) VALUES (?, ?, ?, ?, ?)'
  ).run(username, displayName || username, email || `${username}@${provider}.local`, '', avatarUrl || '');

  const userId = result.lastInsertRowid as number;

  db.prepare(
    'INSERT INTO user_auth_providers (user_id, provider, provider_user_id, provider_email, provider_display_name, provider_avatar_url) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, provider, providerId, email, displayName, avatarUrl);

  return { userId, username };
}

// ─── Configure Passport ───

export function configurePassport(): void {
  // Serialize minimal user info into session
  passport.serializeUser((user: any, done) => {
    done(null, { id: user.id, username: user.username, role: user.role || 'user', is_verified: user.is_verified ?? 0, profile_visibility: user.profile_visibility || 'public' });
  });

  passport.deserializeUser((obj: any, done) => {
    done(null, obj);
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
      const email = profile.emails?.[0]?.value || '';
      const verified = profile.emails?.[0]?.verified || false;
      const safeEmail = verified ? email : '';
      const displayName = profile.displayName || profile.name?.givenName || '';
      const avatarUrl = profile.photos?.[0]?.value || '';
      const result = findOrCreateUser('google', profile.id, safeEmail, displayName, avatarUrl);
      done(null, { id: result.userId, username: result.username, role: 'user', is_verified: 0, profile_visibility: 'public', game_discovery_enabled: 0 });
    } catch (err) {
      done(err as Error);
    }
  }));
  console.log('[auth] Google OAuth registered' + (process.env.GOOGLE_CLIENT_ID ? ' (configured)' : ' (not configured)'));

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
      const result = findOrCreateUser('steam', profile.id || _identifier, '', displayName, avatarUrl);
      done(null, { id: result.userId, username: result.username, role: 'user', is_verified: 0, profile_visibility: 'public', game_discovery_enabled: 0 });
    } catch (err) {
      done(err);
    }
  }));
  console.log('[auth] Steam OpenID registered' + ((process.env.STEAM_RETURN_URL || process.env.APP_BASE_URL) ? ' (configured)' : ' (not configured)'));
}

// ─── OAuth Callback Handler ───

export function handleOAuthCallback(req: any, res: any): void {
  const user = req.user as { id: number; username: string } | undefined;
  if (!user) {
    logAuthEvent({ eventType: 'oauth_failure', success: false, reason: 'OAUTH_PROVIDER_ERROR', ip: getClientIp(req), userAgent: req.headers?.['user-agent'] });
    res.redirect(`${WEB_URL}/login?error=oauth_failed`);
    return;
  }
  logAuthEvent({ eventType: 'oauth_success', userId: user.id, ip: getClientIp(req), userAgent: req.headers?.['user-agent'], meta: { username: user.username } });
  const token = generateToken({
    id: user.id,
    username: user.username,
    display_name: user.username,
    email: '',
    role: 'user', is_verified: 0, profile_visibility: "public", feed_exposure: "extended", world_home_injection: "world_home_few", game_discovery_enabled: 0, dm_privacy: "friends_of_friends",
    banned: 0,
  });

  // Store the JWT in the server-side session for one-time retrieval by the frontend.
  // This keeps the token out of the redirect URL, which would expose it via browser
  // history, proxy/server logs, and Referer headers.
  // The frontend calls GET /api/auth/oauth-token (with credentials) to claim it.
  req.session.oauthHandoffToken = token;
  req.session.oauthHandoffUsername = user.username;
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
