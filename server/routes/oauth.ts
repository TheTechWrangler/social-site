import { Router } from 'express';
import passport from 'passport';
import { getSafeWebBaseUrl, handleOAuthCallback, isGoogleConfigured, isSteamConfigured } from '../authProviders.js';

const router = Router();
const WEB_URL = getSafeWebBaseUrl();

// GET /api/auth/providers — check which providers are configured
router.get('/providers', (_req, res) => {
  res.json({
    google: isGoogleConfigured(),
    steam: isSteamConfigured(),
  });
});

// GET /api/auth/google — start Google login
router.get('/google', (req, res, next) => {
  if (!isGoogleConfigured()) {
    return res.redirect(`${WEB_URL}/login?error=google_not_configured`);
  }
  next();
}, passport.authenticate('google', {
  scope: ['profile', 'email'],
  session: true,
}));

// GET /api/auth/google/callback
router.get('/google/callback', passport.authenticate('google', {
  failureRedirect: '/api/auth/oauth-error?provider=google',
  session: true,
}), handleOAuthCallback);

// GET /api/auth/steam — start Steam login
router.get('/steam', (req, res, next) => {
  if (!isSteamConfigured()) {
    return res.redirect(`${WEB_URL}/login?error=steam_not_configured`);
  }
  next();
}, passport.authenticate('steam', {
  session: true,
}));

// GET /api/auth/steam/callback
router.get('/steam/callback', passport.authenticate('steam', {
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
