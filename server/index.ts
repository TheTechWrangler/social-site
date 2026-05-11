import 'dotenv/config';
import express from 'express';
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
import uploadRoutes from './routes/uploads.js';
import gamesRoutes from './routes/games.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3003;
const SESSION_SECRET = process.env.SESSION_SECRET || 'social-site-session-dev-secret';

const app = express();

// Session (required for OAuth)
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // set true in production with HTTPS
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
}

app.use('/uploads', express.static(path.resolve(__dirname, '..', 'uploads')));

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
app.use('/api/admin/rss', rssAdminRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'social-site' }));

// Start
initializeDatabase();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Social Site running on http://0.0.0.0:${PORT}`);
});
