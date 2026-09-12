import './runtimeLease.js';
import { RequestValidationError } from './requestValidation.js';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase, runRetentionCleanup, getDb } from './database.js';
import { configurePassport } from './authProviders.js';
import authRoutes from './routes/auth.js';
import oauthRoutes from './routes/oauth.js';
import feedRoutes from './routes/feed.js';
import postRoutes from './routes/posts.js';
import userRoutes from './routes/users.js';
import followRoutes from './routes/follows.js';
import likeRoutes from './routes/likes.js';
import commentRoutes from './routes/comments.js';
import repostRoutes from './routes/reposts.js';
import groupRoutes from './routes/groups.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import { publicRouter as rssPublicRouter, adminRouter as rssAdminRouter } from './routes/rss.js';
import worldCommentsRoutes from './routes/worldComments.js';
import uploadRoutes, { uploadsFileRouter } from './routes/uploads.js';
import gamesRoutes from './routes/games.js';
import messagesRoutes from './routes/messages.js';
import usageRoutes from './routes/usage.js';
import reportsRoutes from './routes/reports.js';
import { SQLiteSessionStore } from './sessionStore.js';
import { PASSPORT_SESSION_COOKIE_NAME } from './browserSession.js';
import { isEmailConfigured } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3003;
const IS_PROD = process.env.NODE_ENV === 'production';

// ─── Global process error handlers ───
// Register before any async work so every unhandled failure is captured.
//
// uncaughtException: a synchronous throw escaped every try/catch. Process state is
// indeterminate — log the full error and exit so systemd restarts cleanly.
//
// unhandledRejection: an async/await or Promise chain resolved without a rejection
// handler. Node 18+ terminates on these by default. We log clearly without exiting
// because the global Express error handler below may still catch the same error via
// next(err); exiting here would race with that handler and abort in-flight requests.
process.on('uncaughtException', (err: Error) => {
  console.error('[fatal] uncaughtException — exiting for systemd restart:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[fatal] unhandledRejection — unhandled Promise rejection:', reason);
});

// ─── Environment startup log ───
console.log(`[env] NODE_ENV=${process.env.NODE_ENV ?? '(not set)'}`);
// Safety check: if WEB_BASE_URL points at the live domain but NODE_ENV is not
// 'production', the auth cookie will lack the Secure flag — sessions are
// exploitable over unencrypted connections. Loud warning so it is not missed.
if (!IS_PROD && (process.env.WEB_BASE_URL ?? '').includes('refugecloud.com')) {
  console.warn(
    '[env] WARNING: WEB_BASE_URL contains "refugecloud.com" but NODE_ENV is not "production". ' +
    'Auth cookies will NOT have the Secure flag. Set NODE_ENV=production in the systemd unit.',
  );
}

// ─── Production secret guards ───
// Refuse startup in production if required secrets are missing.
if (IS_PROD) {
  if (!process.env.JWT_SECRET) {
    console.error('[startup] FATAL: JWT_SECRET environment variable is required in production.');
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET) {
    console.error('[startup] FATAL: SESSION_SECRET environment variable is required in production.');
    process.exit(1);
  }
} else {
  if (!process.env.JWT_SECRET) {
    console.warn('[startup] WARNING: JWT_SECRET not set — using insecure dev fallback. Set it before deploying.');
  }
  if (!process.env.SESSION_SECRET) {
    console.warn('[startup] WARNING: SESSION_SECRET not set — using insecure dev fallback. Set it before deploying.');
  }
}

const SESSION_SECRET = process.env.SESSION_SECRET || 'social-site-session-dev-secret';

const app = express();

// Session/auth stores must exist before middleware constructors perform cleanup.
initializeDatabase();
runRetentionCleanup();

// ─── Trust proxy (required for correct rate-limit IPs behind Nginx Proxy Manager) ───
// Set TRUST_PROXY=1 in production when behind a single reverse proxy.
const trustProxy = process.env.TRUST_PROXY === '1' ? 1 : false;
if (trustProxy) app.set('trust proxy', trustProxy);

// ─── Security headers (Helmet) ───
// CSP intentionally permits:
//   - YouTube embeds (frame-src)
//   - External RSS/article images (img-src https:)
//   - External podcast/audio URLs (media-src https:)
//   - Protected /uploads files (served same-origin)
//   - Inline styles (React renders style={} as style attributes — requires unsafe-inline)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Cloudflare Web Analytics beacon — only this exact static host is permitted.
      scriptSrc: ["'self'", 'https://static.cloudflareinsights.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      mediaSrc: ["'self'", 'https:'],
      frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Session (required for OAuth)
// SQLiteSessionStore replaces the default MemoryStore so sessions survive service restarts
// and no longer emit the "MemoryStore is not designed for production" warning.
// Cookie settings are unchanged: httpOnly, secure (prod only), sameSite=lax, 24 h maxAge.
app.use(session({
  name: PASSPORT_SESSION_COOKIE_NAME,
  store: new SQLiteSessionStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    // Requires HTTPS in production. Behind Nginx Proxy Manager, also set TRUST_PROXY=1.
    secure: IS_PROD,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
  },
}));

// Email
if (isEmailConfigured()) {
  console.log('[email] Resend: configured');
} else {
  console.warn('[email] RESEND_API_KEY not set — email verification disabled. Users can still register; verification emails will not be sent until RESEND_API_KEY is configured.');
}

// Passport
configurePassport();
app.use(passport.initialize());
app.use(passport.session());
// Passport identity is temporary OAuth machinery, never an application viewer.
// Provider callback authentication runs later inside its route and may repopulate
// req.user for handleOAuthCallback; all other routes start with no inherited user.
app.use((req, _res, next) => {
  req.user = undefined;
  next();
});

// ─── CORS ───
const corsOrigin = process.env.WEB_BASE_URL || 'http://localhost:5174';
if (!process.env.WEB_BASE_URL) {
  console.warn('[cors] WEB_BASE_URL is not set — falling back to http://localhost:5174 (dev only)');
} else if (corsOrigin.endsWith('/')) {
  console.warn(`[cors] WEB_BASE_URL has a trailing slash ("${corsOrigin}") — CORS may fail; remove the trailing slash`);
} else if (!/^https?:\/\//i.test(corsOrigin)) {
  console.warn(`[cors] WEB_BASE_URL does not start with http:// or https:// ("${corsOrigin}") — CORS may fail`);
} else {
  console.log(`[cors] Origin: ${corsOrigin}`);
}
app.use(cors({
  origin: corsOrigin,
  credentials: true,
}));
app.use(express.json({ limit: '64kb' }));

// ─── Rate Limiting ───
if ((process.env.RATE_LIMIT_ENABLED || 'true') !== 'false') {
  const skipReadMethods = (req: express.Request) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const authLimiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '10', 10),
    message: { error: 'Too many attempts. Please try again later.' },
    standardHeaders: true, legacyHeaders: false,
  });
  // Tighter limiter for forgot-password — prevents email spam / account enumeration at scale.
  const forgotPasswordLimiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_FORGOT_PASSWORD_MAX || '5', 10),
    message: { error: 'Too many password reset requests. Please wait before trying again.' },
    standardHeaders: true, legacyHeaders: false,
  });
  const writeLimiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_WRITE_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_WRITE_MAX || '60', 10),
    message: { error: 'Too many requests. Please slow down.' },
    standardHeaders: true, legacyHeaders: false,
    skip: skipReadMethods,
  });
  const uploadLimiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_WRITE_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_UPLOAD_MAX || '20', 10),
    message: { error: 'Too many uploads. Please slow down.' },
    standardHeaders: true, legacyHeaders: false,
  });
  const feedReadLimiter = rateLimit({
    skip: req => !skipReadMethods(req),
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_FEED_MAX || '120', 10),
    message: { error: 'Too many requests. Please slow down.' },
    standardHeaders: true, legacyHeaders: false,
  });
  const usageEventLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_USAGE_MAX || '120', 10),
    message: { error: 'Too many analytics events. Please slow down.' },
    standardHeaders: true, legacyHeaders: false,
  });
  const pollingReadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_POLLING_MAX || '600', 10),
    message: { error: 'Too many polling requests. Please slow down.' },
    standardHeaders: true, legacyHeaders: false,
  });
  const userSearchLimiter = rateLimit({
    skip: req => !skipReadMethods(req) || req.path !== '/',
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_USER_SEARCH_MAX || '60', 10),
    message: { error: 'Too many user search requests. Please slow down.' },
    standardHeaders: true, legacyHeaders: false,
  });
  // Tight dedicated limiter for resend-verification — prevents email-quota abuse.
  // Uses the same window as the general auth limiter but a much lower request cap.
  const resendVerifLimiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_RESEND_VERIFICATION_MAX || '3', 10),
    message: { error: 'Too many verification emails requested. Please wait before trying again.' },
    standardHeaders: true, legacyHeaders: false,
  });

  const networkLimiter = rateLimit({
    windowMs: 60000, max: 6,
    standardHeaders: true, legacyHeaders: false,
    skip: req => req.method !== 'POST',
    message: { error: 'Too many RSS refreshes. Wait a minute before retrying.' },
  });
  app.use('/api/admin/rss/sources/:id/fetch', networkLimiter);
  app.use('/api/admin/rss/fetch-all', networkLimiter);
  app.use('/api/feed/replenish', networkLimiter);
  const listReadLimiter = rateLimit({
    windowMs: 15 * 60000, max: 300,
    standardHeaders: true, legacyHeaders: false,
    skip: req => !skipReadMethods(req) || req.path === '/unread-count',
    message: { error: 'Too many list requests. Please slow down.' },
  });
  app.use(['/api/world-feed', '/api/groups', '/api/comments', '/api/messages', '/api/notifications', '/api/games'], listReadLimiter);
  app.use(['/api/groups', '/api/users', '/api/notifications'], writeLimiter);
  // Feed read endpoints
  app.use('/api/feed', feedReadLimiter);
  // User search/profile endpoints
  app.use('/api/users', userSearchLimiter);
  // Lightweight client telemetry
  app.use('/api/usage/event', usageEventLimiter);
  // Lightweight polling endpoints (generous for normal 30s polling across tabs)
  app.use('/api/notifications/unread-count', pollingReadLimiter);
  app.use('/api/messages/unread-count', pollingReadLimiter);
  // Auth endpoints
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/reset-password', authLimiter);
  app.use('/api/auth/forgot-password', forgotPasswordLimiter);
  app.use('/api/auth/oauth-token', authLimiter);
  app.use('/api/auth/resend-verification', resendVerifLimiter);  // tighter: 3 / window
  app.use('/api/auth/resend-verification', authLimiter);          // general fallback: 10 / window
  app.use('/api/auth/verify-email', authLimiter);
  // Upload endpoints
  app.use('/api/uploads/avatar', uploadLimiter);
  app.use('/api/uploads/image', uploadLimiter);
  app.use('/api/uploads/video', uploadLimiter);
  app.use('/api/uploads/external-video', uploadLimiter);
  // Write endpoints
  app.use('/api/posts', writeLimiter);
  app.use('/api/comments', writeLimiter);
  app.use('/api/likes', writeLimiter);
  app.use('/api/reposts', writeLimiter);
  app.use('/api/world-feed', writeLimiter);
  app.use('/api/games', writeLimiter);
  app.use('/api/follows', writeLimiter);
  app.use('/api/messages', writeLimiter);
}

app.use('/uploads', uploadsFileRouter);

// ─── CSRF Origin / Referer Check ───
// Now that auth uses HttpOnly cookies, cross-origin state-changing requests could
// carry the cookie automatically (CSRF). SameSite=Lax on the cookie already blocks
// cross-site POST from being sent with cookies, but we add an Origin/Referer check
// as defence-in-depth for all state-changing /api routes.
//
// Decision tree (non-GET/HEAD/OPTIONS only):
//   Origin present              → must match an allowed frontend origin
//   Origin absent, Referer set  → Referer's origin must match an allowed frontend origin
//   Both absent                 → allowed in dev (NODE_ENV≠production) or from localhost
//
// Allowed origins: production + WEB_BASE_URL + localhost dev variants (both name forms).
const CSRF_ALLOWED_ORIGINS = new Set<string>([
  'https://refugecloud.com',
  'https://www.refugecloud.com',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
  'http://localhost:3003',
  'http://127.0.0.1:3003',
  ...(process.env.WEB_BASE_URL
    ? [process.env.WEB_BASE_URL.replace(/\/$/, '')]
    : []),
]);

function extractOriginFromUrl(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

app.use('/api', (req: express.Request, res: express.Response, next: express.NextFunction) => {
  // OAuth initiation/callback and the one-time handoff currently use GET and are
  // protected by unpredictable session-bound state. All POST/PUT/PATCH/DELETE
  // application mutations continue through the origin policy below.
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) { next(); return; }

  const origin = req.headers.origin;
  if (origin) {
    if (CSRF_ALLOWED_ORIGINS.has(origin)) { next(); return; }
    res.status(403).json({ error: 'Invalid request origin.' });
    return;
  }

  const referer = req.headers.referer;
  if (referer) {
    const refOrigin = extractOriginFromUrl(referer);
    if (refOrigin && CSRF_ALLOWED_ORIGINS.has(refOrigin)) { next(); return; }
    res.status(403).json({ error: 'Invalid request origin.' });
    return;
  }

  // No Origin or Referer — tools/curl. Allow in dev or from localhost/127.0.0.1.
  const enforcingInTests = !IS_PROD && process.env.CSRF_ENFORCE_IN_TESTS === 'true';
  if (!IS_PROD && !enforcingInTests) { next(); return; }
  const host = (req.headers.host || '').split(':')[0];
  if (!enforcingInTests && (host === 'localhost' || host === '127.0.0.1')) { next(); return; }
  res.status(403).json({ error: 'Invalid request origin.' });
});

// API routes
app.use('/api/auth', oauthRoutes);  // OAuth routes first (more specific paths)
app.use('/api/auth', authRoutes);   // Then regular auth (register, login, me)
app.use('/api/feed', feedRoutes);
app.use('/api/posts', postRoutes);
app.use('/api/users', userRoutes);
app.use('/api/follows', followRoutes);
app.use('/api/likes', likeRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/reposts', repostRoutes);
app.use('/api/groups', groupRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/reports', reportsRoutes);              // User-submitted moderation reports
app.use('/api/admin', adminRoutes);
app.use('/api/world-feed', rssPublicRouter);
app.use('/api/world-feed', worldCommentsRoutes);  // Comments on RSS items
app.use('/api/uploads', uploadRoutes);               // Media uploads
app.use('/api/games', gamesRoutes);                   // Games & LFG
app.use('/api/messages', messagesRoutes);             // Direct messages
app.use('/api/admin/rss', rssAdminRouter);
app.use('/api/usage', usageRoutes);

app.get('/api/health', (_req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    res.json({ ok: true, app: 'social-site' });
  } catch {
    res.status(503).json({ ok: false, error: 'db_unavailable' });
  }
});

// ─── Serve React SPA (production only) ───
// In dev, Vite handles the frontend separately via `npm run dev`.
// In production (NODE_ENV=production), Express serves the built dist/.
// Return JSON 404 for any unmatched /api/* route — applies in both dev and prod
// so unknown API paths never silently return HTML (index.html or Vite dev 404 page).
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

if (IS_PROD) {
  const distPath = path.join(__dirname, '../dist');
  // Serve static assets (hashed JS/CSS/fonts use default caching — their filenames change on rebuild).
  // index.html gets no-cache so browsers always fetch the latest SPA shell after deployments.
  app.use(express.static(distPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
  // SPA fallback — every non-API path serves the React shell with no-cache headers
  app.get('*', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ─── Global error handler ───
// Must be registered AFTER all routes. Catches errors passed via next(err) or
// thrown in async middleware that have not been caught by individual route try/catch blocks.
// Never leaks secrets, tokens, stack traces, or request bodies to clients.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof RequestValidationError) { res.status(400).json({ error: err.message }); return; }
  if (err.status === 400 && err.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Request body must contain valid JSON.' });
    return;
  }
  if (err.status === 413 && err.type === 'entity.too.large') {
    res.status(413).json({ error: 'Request body is too large.' });
    return;
  }
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Refuge Cloud running on http://0.0.0.0:${PORT}`);
});
