import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import session from 'express-session';
import passport from 'passport';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeDatabase } from './database.js';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3003;
const IS_PROD = process.env.NODE_ENV === 'production';

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
      scriptSrc: ["'self'"],
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
app.use(session({
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

// Passport
configurePassport();
app.use(passport.initialize());
app.use(passport.session());

app.use(cors({
  origin: process.env.WEB_BASE_URL || 'http://localhost:5174',
  credentials: true,
}));
app.use(express.json());

// ─── Rate Limiting ───
if ((process.env.RATE_LIMIT_ENABLED || 'true') !== 'false') {
  const authLimiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_AUTH_MAX || '10', 10),
    message: { error: 'Too many attempts. Please try again later.' },
    standardHeaders: true, legacyHeaders: false,
  });
  const writeLimiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_WRITE_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_WRITE_MAX || '60', 10),
    message: { error: 'Too many requests. Please slow down.' },
    standardHeaders: true, legacyHeaders: false,
  });
  const uploadLimiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_WRITE_WINDOW_MINUTES || '15', 10)) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_UPLOAD_MAX || '20', 10),
    message: { error: 'Too many uploads. Please slow down.' },
    standardHeaders: true, legacyHeaders: false,
  });

  // Auth endpoints
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/auth/reset-password', authLimiter);
  app.use('/api/auth/oauth-token', authLimiter);
  // Upload endpoints
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
app.use('/api/admin', adminRoutes);
app.use('/api/world-feed', rssPublicRouter);
app.use('/api/world-feed', worldCommentsRoutes);  // Comments on RSS items
app.use('/api/uploads', uploadRoutes);               // Media uploads
app.use('/api/games', gamesRoutes);                   // Games & LFG
app.use('/api/messages', messagesRoutes);             // Direct messages
app.use('/api/admin/rss', rssAdminRouter);
app.use('/api/usage', usageRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'social-site' }));

// ─── Serve React SPA (production only) ───
// In dev, Vite handles the frontend separately via `npm run dev`.
// In production (NODE_ENV=production), Express serves the built dist/.
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
  // 404 for any unmatched /api/* so they don't silently serve index.html
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
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
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

// Start
initializeDatabase();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Refuge Cloud running on http://0.0.0.0:${PORT}`);
});
