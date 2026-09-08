import { Router } from 'express';
import passport from 'passport';
import { getSafeWebBaseUrl, handleOAuthCallback, isGoogleConfigured, isSteamConfigured } from '../authProviders.js';
import {
  consumeGoogleOAuthState,
  consumeSteamLoginIntent,
  issueGoogleOAuthState,
  issueSteamLoginIntent,
  type OAuthStateSession,
} from '../oauthState.js';

const router = Router();
const WEB_URL = getSafeWebBaseUrl();

function saveSessionThenRedirect(req: any, res: any, next: any, location: string): void {
  req.session.save((err: Error | null) => {
    if (err) { next(err); return; }
    res.redirect(location);
  });
}

// GET /api/auth/providers — check which providers are configured
router.get('/providers', (_req, res) => {
  res.json({
    google: isGoogleConfigured(),
    steam: isSteamConfigured(),
  });
});

// GET /api/auth/google — start Google login with one-time session-backed state.
router.get('/google', (req, res, next) => {
  if (!isGoogleConfigured()) {
    res.redirect(`${WEB_URL}/login?error=google_not_configured`);
    return;
  }

  const state = issueGoogleOAuthState(req.session as OAuthStateSession);
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: true,
    state,
  })(req, res, next);
});

// GET /api/auth/google/callback
router.get('/google/callback', (req, res, next) => {
  const stateResult = consumeGoogleOAuthState(
    req.session as OAuthStateSession,
    req.query.state,
  );
  if (!stateResult.ok) {
    saveSessionThenRedirect(req, res, next, `${WEB_URL}/login?error=google_failed`);
    return;
  }
  next();
}, passport.authenticate('google', {
  failureRedirect: '/api/auth/oauth-error?provider=google',
  session: true,
}), handleOAuthCallback);

// GET /api/auth/steam — start Steam login. OpenID has no OAuth state
// parameter, so retain a short-lived one-time login intent in the session.
router.get('/steam', (req, res, next) => {
  if (!isSteamConfigured()) {
    res.redirect(`${WEB_URL}/login?error=steam_not_configured`);
    return;
  }

  issueSteamLoginIntent(req.session as OAuthStateSession);
  passport.authenticate('steam', { session: true })(req, res, next);
});

// GET /api/auth/steam/callback
router.get('/steam/callback', (req, res, next) => {
  if (!consumeSteamLoginIntent(req.session as OAuthStateSession)) {
    saveSessionThenRedirect(req, res, next, `${WEB_URL}/login?error=steam_failed`);
    return;
  }
  next();
}, passport.authenticate('steam', {
  failureRedirect: '/api/auth/oauth-error?provider=steam',
  session: true,
}), handleOAuthCallback);

// GET /api/auth/oauth-error
router.get('/oauth-error', (req, res) => {
  const rawProvider = typeof req.query.provider === 'string' ? req.query.provider : '';
  const provider = ['google', 'steam'].includes(rawProvider) ? rawProvider : 'provider';
  res.redirect(`${WEB_URL}/login?error=${provider}_failed`);
});

export default router;
