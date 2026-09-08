import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../database.js';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware.js';
import { logAuthEvent } from '../authEvents.js';
import { logUsage } from '../usageEvents.js';
import { isGoogleConfigured, isSteamConfigured } from '../authProviders.js';
import { getStorageConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeStorage = getStorageConfig();

// Cache package version once at startup — avoids per-request disk read in system-health.
let APP_VERSION = 'unknown';
try {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  APP_VERSION = pkg.version || 'unknown';
} catch { /* non-fatal — version stays 'unknown' */ }

const router = Router();
const REPORT_ERROR = 'Please select a reason and briefly explain the problem.';
const REPORT_REASONS = new Set(['Spam', 'Harassment', 'Hate or abuse', 'Sexual content', 'Violence or threats', 'Scam or unsafe link', 'Other']);

function activeAdminCount(): number {
  return (getDb().prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND banned = 0").get() as any).c;
}

function logBlockedAdminGuard(eventType: 'admin_self_ban_blocked' | 'admin_last_admin_ban_blocked' | 'admin_last_admin_demote_blocked', adminId: number, targetUserId: number, reason: string): void {
  logAuthEvent({
    eventType,
    userId: targetUserId,
    success: false,
    reason,
    adminActorId: adminId,
    targetUserId,
  });
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePageLimit(query: any, defaultLimit: number, maxLimit: number): { page: number; limit: number; offset: number } {
  const page = parsePositiveInt(query.page, 1);
  const limit = Math.min(parsePositiveInt(query.limit, defaultLimit), maxLimit);
  return { page, limit, offset: (page - 1) * limit };
}

// GET /api/admin/users
router.get('/users', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const { page, limit, offset } = parsePageLimit(req.query, 50, 200);
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
  const role = typeof req.query.role === 'string' && ['admin', 'mod', 'user'].includes(req.query.role) ? req.query.role : '';
  const where: string[] = [];
  const params: any[] = [];

  if (q) {
    where.push('(username LIKE ? OR display_name LIKE ? OR email LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (role) {
    where.push('role = ?');
    params.push(role);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) as c FROM users ${whereSql}`).get(...params) as any).c as number;
  const users = db.prepare(`
    SELECT id, username, display_name, email, role, banned, is_verified, profile_visibility, feed_exposure, created_at
    FROM users
    ${whereSql}
    ORDER BY id
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ users, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), activeAdminCount: activeAdminCount() });
});

// POST /api/admin/users/:id/ban
router.post('/users/:id/ban', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const targetId = Number(req.params.id);
  const db = getDb();

  if (targetId === adminId) {
    logBlockedAdminGuard('admin_self_ban_blocked', adminId, targetId, 'self_ban_blocked');
    res.status(400).json({ error: 'You cannot ban your own account.' }); return;
  }

  const target = db.prepare('SELECT id, role, banned FROM users WHERE id = ?').get(targetId) as any;
  if (!target) { res.status(404).json({ error: 'User not found.' }); return; }

  if (target.role === 'admin' && !target.banned && activeAdminCount() <= 1) {
    logBlockedAdminGuard('admin_last_admin_ban_blocked', adminId, targetId, 'last_active_admin');
    res.status(400).json({ error: 'Cannot ban the last active admin.' }); return;
  }

  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(targetId);
  logAuthEvent({ eventType: 'admin_ban', userId: targetId, adminActorId: adminId, targetUserId: targetId });
  res.json({ ok: true });
});

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const targetId = Number(req.params.id);
  getDb().prepare('UPDATE users SET banned = 0 WHERE id = ?').run(targetId);
  logAuthEvent({ eventType: 'admin_unban', userId: targetId, adminActorId: adminId, targetUserId: targetId });
  res.json({ ok: true });
});

// GET /api/admin/posts
router.get('/posts', requireAuth, requireAdmin, (_req, res) => {
  const rows = getDb().prepare(`
    SELECT p.*, u.username FROM posts p JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC LIMIT 100
  `).all();
  res.json({ posts: rows });
});

// POST /api/admin/posts/:id/hide
router.post('/posts/:id/hide', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const postId = Number(req.params.id);
  const result = getDb().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(postId);
  if (result.changes === 0) { res.status(404).json({ error: 'Content not found.' }); return; }
  logAuthEvent({ eventType: 'admin_hide_post', userId: adminId, adminActorId: adminId, meta: { postId } });
  res.json({ ok: true });
});

// POST /api/admin/posts/:id/unhide
router.post('/posts/:id/unhide', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const postId = Number(req.params.id);
  const result = getDb().prepare('UPDATE posts SET hidden = 0 WHERE id = ?').run(postId);
  if (result.changes === 0) { res.status(404).json({ error: 'Content not found.' }); return; }
  logAuthEvent({ eventType: 'admin_unhide_post', userId: adminId, adminActorId: adminId, meta: { postId } });
  res.json({ ok: true });
});

// GET /api/admin/reports
router.get('/reports', requireAuth, requireAdmin, (req, res) => {
  const db = getDb();
  const { page, limit, offset } = parsePageLimit(req.query, 50, 200);
  const statusFilter = req.query.status as string;
  const hasFilter = statusFilter && ['open', 'resolved', 'dismissed'].includes(statusFilter);
  const whereClause = hasFilter ? 'WHERE r.status = ?' : '';
  const params: any[] = hasFilter ? [statusFilter] : [];

  const baseSql = `
    FROM reports r
    JOIN users u ON r.reporter_id = u.id
    LEFT JOIN posts p ON r.post_id = p.id
    LEFT JOIN users pu ON p.user_id = pu.id
    ${whereClause}
  `;

  const total = (db.prepare(`SELECT COUNT(*) as c ${baseSql}`).get(...params) as any).c as number;
  const reports = db.prepare(`
    SELECT r.*, u.username as reporter_name, p.content as post_content, p.user_id as post_author_id,
      p.parent_id as post_parent_id, pu.username as post_author_name, p.hidden as post_hidden
    ${baseSql}
    ORDER BY r.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({ reports, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

// PATCH /api/admin/reports/:id
router.patch('/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const { status, adminNote } = req.body;
  const nextStatus = status && ['open','resolved','dismissed'].includes(status) ? status : undefined;
  const note = adminNote !== undefined ? String(adminNote).trim().slice(0, 1000) : undefined;
  if (!nextStatus && note === undefined) { res.status(400).json({ error: 'No valid updates.' }); return; }

  const db = getDb();
  const report = db.prepare('SELECT id, post_id FROM reports WHERE id = ?').get(req.params.id) as any;
  if (!report) { res.status(404).json({ error: 'Report not found.' }); return; }

  if (nextStatus === 'resolved') {
    if (!report.post_id) { res.status(400).json({ error: 'Reported content is missing.' }); return; }
    const post = db.prepare('SELECT id FROM posts WHERE id = ?').get(report.post_id);
    if (!post) { res.status(404).json({ error: 'Reported content not found.' }); return; }
  }

  const updateReport = db.transaction(() => {
    if (nextStatus === 'resolved') {
      db.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(report.post_id);
    }

    const updates: string[] = [];
    const vals: any[] = [];
    if (nextStatus) {
      updates.push('status = ?'); vals.push(nextStatus);
      if (nextStatus !== 'open') {
        updates.push("resolved_at = datetime('now')");
        updates.push('resolved_by = ?'); vals.push((req as any).user.id);
      }
    }
    if (note !== undefined) { updates.push('admin_note = ?'); vals.push(note); }
    vals.push(report.id);
    db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
  });

  updateReport();
  logAuthEvent({
    eventType: 'admin_report_update',
    userId: (req as any).user.id,
    adminActorId: (req as any).user.id,
    meta: { reportId: report.id, ...(nextStatus ? { status: nextStatus } : {}) },
  });
  res.json({ ok: true });
});

// GET /api/admin/stats
router.get('/stats', requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();
  res.json({
    totalUsers: (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c,
    unverifiedUsers: (db.prepare('SELECT COUNT(*) as c FROM users WHERE is_verified = 0').get() as any).c,
    bannedUsers: (db.prepare('SELECT COUNT(*) as c FROM users WHERE banned = 1').get() as any).c,
    openReports: (db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'open'").get() as any).c,
    hiddenPosts: (db.prepare('SELECT COUNT(*) as c FROM posts WHERE hidden = 1').get() as any).c,
    activeRssSources: (db.prepare('SELECT COUNT(*) as c FROM rss_sources WHERE is_active = 1').get() as any).c,
    rssItemCount: (db.prepare('SELECT COUNT(*) as c FROM rss_items').get() as any).c,
    gameCount: (db.prepare('SELECT COUNT(*) as c FROM games').get() as any).c,
    serverCount: (db.prepare('SELECT COUNT(*) as c FROM game_servers WHERE is_active = 1').get() as any).c,
    lfgCount: (db.prepare("SELECT COUNT(*) as c FROM game_lfg_posts WHERE is_active = 1 AND expires_at > datetime('now')").get() as any).c,
  });
});

// POST /api/admin/reports
router.post('/reports', requireAuth, (req: AuthRequest, res) => {
  const { postId } = req.body;
  const reason = String(req.body.reason || '').trim().slice(0, 120);
  const details = String(req.body.details ?? req.body.report_details ?? '').trim().slice(0, 1000);
  if (!postId || !reason || details.length < 5) { res.status(400).json({ error: REPORT_ERROR }); return; }
  if (!REPORT_REASONS.has(reason)) { res.status(400).json({ error: REPORT_ERROR }); return; }
  const post = getDb().prepare('SELECT id FROM posts WHERE id = ?').get(postId);
  if (!post) { res.status(404).json({ error: 'Content not found.' }); return; }
  getDb().prepare('INSERT INTO reports (reporter_id, post_id, reason, report_details) VALUES (?, ?, ?, ?)')
    .run(req.user!.id, postId, reason, details);
  res.status(201).json({ ok: true });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const viewerId = (req as any).user.id;
  const targetId = Number(req.params.id);

  if (targetId === viewerId) {
    res.status(400).json({ error: 'You cannot delete your own account.' }); return;
  }

  const target = getDb().prepare('SELECT id, username, role, banned FROM users WHERE id = ?').get(targetId) as any;
  if (!target) { res.status(404).json({ error: 'User not found.' }); return; }

  if (target.role === 'admin' && !target.banned && activeAdminCount() <= 1) {
    res.status(400).json({ error: 'Cannot delete the last active admin.' }); return;
  }

  // reports.resolved_by has no cascade — null it first to avoid dangling FK
  getDb().prepare('UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?').run(targetId);

  // All other related data cascades via ON DELETE CASCADE on the users FK
  getDb().prepare('DELETE FROM users WHERE id = ?').run(targetId);

  logAuthEvent({ eventType: 'admin_delete_user', adminActorId: viewerId, targetUserId: targetId, meta: { username: target.username, role: target.role } });
  res.json({ ok: true });
});

// POST /api/admin/users/:id/verify
router.post('/users/:id/verify', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const targetId = Number(req.params.id);
  getDb().prepare("UPDATE users SET is_verified = 1, verified_at = datetime('now'), verified_by = ? WHERE id = ?")
    .run(adminId, targetId);
  logAuthEvent({ eventType: 'admin_verify_user', userId: targetId, adminActorId: adminId, targetUserId: targetId });
  res.json({ ok: true });
});

// POST /api/admin/users/:id/unverify
router.post('/users/:id/unverify', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const targetId = Number(req.params.id);
  getDb().prepare('UPDATE users SET is_verified = 0, verified_at = NULL, verified_by = NULL WHERE id = ? AND role != ?')
    .run(targetId, 'admin');
  logAuthEvent({ eventType: 'admin_unverify_user', userId: targetId, adminActorId: adminId, targetUserId: targetId });
  res.json({ ok: true });
});

// POST /api/admin/users/:id/role
router.post('/users/:id/role', requireAuth, requireAdmin, (req, res) => {
  const { role } = req.body;
  if (!['user', 'mod', 'admin'].includes(role)) {
    res.status(400).json({ error: 'Role must be user, mod, or admin.' }); return;
  }
  const targetId = Number(req.params.id);
  const adminId = (req as any).user.id;
  const db = getDb();
  const target = db.prepare('SELECT id, role, banned FROM users WHERE id = ?').get(targetId) as any;
  if (!target) { res.status(404).json({ error: 'User not found.' }); return; }

  if (target.role === 'admin' && role !== 'admin') {
    if (targetId === adminId) {
      logBlockedAdminGuard('admin_last_admin_demote_blocked', adminId, targetId, 'self_demotion_blocked');
      res.status(400).json({ error: 'You cannot demote your own admin account.' }); return;
    }
    if (!target.banned && activeAdminCount() <= 1) {
      logBlockedAdminGuard('admin_last_admin_demote_blocked', adminId, targetId, 'last_active_admin');
      res.status(400).json({ error: 'Cannot demote the last active admin.' }); return;
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  logAuthEvent({ eventType: 'admin_role_change', userId: targetId, adminActorId: adminId, targetUserId: targetId, meta: { newRole: role } });
  res.json({ ok: true, role });
});

// ─── Game Servers Admin ───

router.get('/game-servers', requireAuth, requireAdmin, (_req, res) => {
  const servers = getDb().prepare(`
    SELECT s.*, g.name as game_name, g.slug as game_slug
    FROM game_servers s JOIN games g ON s.game_id = g.id ORDER BY g.name, s.name
  `).all();
  res.json({ servers });
});

router.post('/game-servers', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const { gameId, name, description, connectionHost, connectionPort, platform, status, maxPlayers,
    currentPlayers, isFeatured, isActive, joinInstructions, rulesSummary, discordUrl, websiteUrl, serverType, playStyle, regionOrTimezone } = req.body;
  if (!gameId || !name) { res.status(400).json({ error: 'gameId and name required.' }); return; }
  const r = getDb().prepare(`INSERT INTO game_servers (game_id, name, description, connection_host, connection_port, platform, status, max_players, current_players, is_featured, is_active, join_instructions, rules_summary, discord_url, website_url, server_type, play_style, region_or_timezone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(gameId, name, description||'', connectionHost||'', connectionPort||null, platform||'', status||'unknown',
      maxPlayers||null, currentPlayers||0, isFeatured?1:0, isActive!==undefined?isActive:1,
      joinInstructions||'', rulesSummary||'', discordUrl||'', websiteUrl||'', serverType||'', playStyle||'', regionOrTimezone||'');
  const server = getDb().prepare('SELECT * FROM game_servers WHERE id = ?').get(r.lastInsertRowid);
  logAuthEvent({ eventType: 'admin_game_server_create', userId: adminId, adminActorId: adminId, meta: { serverId: Number(r.lastInsertRowid), name } });
  res.status(201).json({ server });
});

router.patch('/game-servers/:id', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const serverId = Number(req.params.id);
  const fields = ['name','description','connection_host','connection_port','platform','status','max_players',
    'current_players','is_featured','is_active','join_instructions','rules_summary','discord_url','website_url','server_type','play_style','region_or_timezone'];
  const sets: string[] = [];
  const vals: any[] = [];
  for (const f of fields) {
    const key = f.replace(/_./g, m => m[1].toUpperCase());
    if (req.body[key] !== undefined) { sets.push(`${f} = ?`); vals.push(req.body[key]); }
  }
  if (sets.length === 0) { res.status(400).json({ error: 'No fields to update.' }); return; }
  sets.push("updated_at = datetime('now')");
  vals.push(req.params.id);
  getDb().prepare(`UPDATE game_servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  logAuthEvent({ eventType: 'admin_game_server_update', userId: adminId, adminActorId: adminId, meta: { serverId } });
  res.json({ ok: true });
});

router.delete('/game-servers/:id', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const serverId = Number(req.params.id);
  getDb().prepare('DELETE FROM game_servers WHERE id = ?').run(req.params.id);
  logAuthEvent({ eventType: 'admin_game_server_delete', userId: adminId, adminActorId: adminId, meta: { serverId } });
  res.json({ ok: true });
});

// ─── Auth Event Log ───

// GET /api/admin/auth-events
router.get('/auth-events', requireAuth, requireAdmin, (req, res) => {
  const { eventType, success, userId } = req.query;
  const { page, limit, offset } = parsePageLimit(req.query, 100, 300);
  const params: any[] = [];
  let where = 'WHERE 1=1';
  if (eventType) { where += ' AND ae.event_type = ?'; params.push(eventType); }
  if (success !== undefined && success !== '') { where += ' AND ae.success = ?'; params.push(success === '1' ? 1 : 0); }
  if (userId) { where += ' AND (ae.user_id = ? OR ae.target_user_id = ?)'; params.push(userId, userId); }
  const total = (getDb().prepare(`SELECT COUNT(*) as c FROM auth_events ae ${where}`).get(...params) as any).c as number;
  const events = getDb().prepare(`
    SELECT ae.*, u.username, u.email,
      aa.username as admin_actor_username,
      tu.username as target_user_username
    FROM auth_events ae
    LEFT JOIN users u ON ae.user_id = u.id
    LEFT JOIN users aa ON ae.admin_actor_id = aa.id
    LEFT JOIN users tu ON ae.target_user_id = tu.id
    ${where}
    ORDER BY ae.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  res.json({ events, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
});

// GET /api/admin/users/:id/activity — user detail + recent auth events + post counts
// Supports ?page=&limit= (default 30, max 100) for auth event pagination.
router.get('/users/:id/activity', requireAuth, requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const db = getDb();
  const user = db.prepare(
    'SELECT id, username, display_name, email, role, banned, is_verified, created_at, last_login_at FROM users WHERE id = ?'
  ).get(userId) as any;
  if (!user) { res.status(404).json({ error: 'User not found.' }); return; }

  const { page, limit, offset } = parsePageLimit(req.query, 30, 100);
  const eventTotal = (db.prepare(
    'SELECT COUNT(*) as c FROM auth_events WHERE user_id = ? OR target_user_id = ?'
  ).get(userId, userId) as any).c as number;

  const events = db.prepare(`
    SELECT id, event_type, success, reason, ip_address, user_agent, admin_actor_id, created_at
    FROM auth_events WHERE user_id = ? OR target_user_id = ?
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(userId, userId, limit, offset) as any[];

  const postCount = (db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND parent_id IS NULL').get(userId) as any).c;
  const commentCount = (db.prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND parent_id IS NOT NULL').get(userId) as any).c;
  const providers = db.prepare('SELECT provider, provider_email, created_at FROM user_auth_providers WHERE user_id = ?').all(userId);

  res.json({
    user, events, postCount, commentCount, providers,
    eventTotal, eventPage: page, eventLimit: limit,
    eventTotalPages: Math.max(1, Math.ceil(eventTotal / limit)),
  });
});

// POST /api/admin/users/:id/password-reset-token — generate a one-time admin-assisted reset link
router.post('/users/:id/password-reset-token', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const targetId = Number(req.params.id);
  const db = getDb();

  const target = db.prepare('SELECT id, username, password_hash FROM users WHERE id = ?').get(targetId) as any;
  if (!target) { res.status(404).json({ error: 'User not found.' }); return; }
  if (!target.password_hash) {
    res.status(400).json({ error: 'User has no local password (OAuth-only account).' }); return;
  }

  // Invalidate any existing unused tokens for this user before creating a new one
  db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(targetId);

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours

  db.prepare(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_by_admin_id) VALUES (?, ?, ?, ?)'
  ).run(targetId, tokenHash, expiresAt, adminId);

  logAuthEvent({ eventType: 'admin_password_reset_token', userId: targetId, adminActorId: adminId, targetUserId: targetId, meta: { username: target.username } });

  // Use WEB_BASE_URL so the link points to the frontend, not the API server.
  const baseUrl = (process.env.WEB_BASE_URL || process.env.APP_BASE_URL || 'https://refugecloud.com').replace(/\/$/, '');
  // rawToken is returned ONCE and never stored. Admin must copy the link immediately.
  res.json({ ok: true, resetLink: `${baseUrl}/reset-password?token=${rawToken}`, expiresAt, username: target.username });
});

// GET /api/admin/system-health — safe read-only diagnostics, no secrets
router.get('/system-health', requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();
  let dbReachable = false;
  try { db.prepare('SELECT 1').get(); dbReachable = true; } catch {}

  const uploadsStats = directoryStats(runtimeStorage.uploadsDir);

  const appVersion = APP_VERSION;

  const googleConfigured = isGoogleConfigured();
  const steamConfigured = isSteamConfigured();

  // Safe: these are not secrets — they're expected public redirect URIs.
  const appBase = (process.env.APP_BASE_URL || 'http://localhost:3003').replace(/\/$/, '');
  const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL || `${appBase}/api/auth/google/callback`;
  const steamReturnUrl = process.env.STEAM_RETURN_URL || `${appBase}/api/auth/steam/callback`;
  const steamRealm = process.env.STEAM_REALM || appBase;

  res.json({
    status: 'ok',
    nodeEnv: process.env.NODE_ENV || 'development',
    appVersion,
    googleOAuth: googleConfigured ? 'Configured' : 'Not configured',
    googleCallbackUrl,
    steamOAuth: steamConfigured ? 'Configured' : 'Not configured',
    steamReturnUrl,
    steamRealm,
    dbReachable,
    uploadsPathOk: uploadsStats.exists,
    uploadsFileCount: uploadsStats.fileCount,
    uploadsSizeBytes: uploadsStats.totalSizeBytes,
    uptimeSeconds: Math.floor(process.uptime()),
    totalUsers: (db.prepare('SELECT COUNT(*) as c FROM users').get() as any).c,
    openReports: (db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'open'").get() as any).c,
    authEventsLast24h: (db.prepare("SELECT COUNT(*) as c FROM auth_events WHERE created_at > datetime('now','-24 hours')").get() as any).c,
  });
});

// ─── Analytics Routes ───

// GET /api/admin/analytics/summary
router.get('/analytics/summary', requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();

  const activeUsersToday = (db.prepare(`
    SELECT COUNT(DISTINCT user_id) as c FROM usage_events
    WHERE user_id IS NOT NULL AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const activeUsers7d = (db.prepare(`
    SELECT COUNT(DISTINCT user_id) as c FROM usage_events
    WHERE user_id IS NOT NULL AND created_at > datetime('now', '-7 days')
  `).get() as any).c;

  const activeUsers30d = (db.prepare(`
    SELECT COUNT(DISTINCT user_id) as c FROM usage_events
    WHERE user_id IS NOT NULL AND created_at > datetime('now', '-30 days')
  `).get() as any).c;

  const pageViewsToday = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'page_view' AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const pageViews7d = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'page_view' AND created_at > datetime('now', '-7 days')
  `).get() as any).c;

  const pageViews30d = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'page_view' AND created_at > datetime('now', '-30 days')
  `).get() as any).c;

  const postsToday = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'post_created' AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const commentsToday = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'comment_created' AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const likesToday = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'like_created' AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const loginSuccessToday = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'login_success' AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const loginFailToday = (db.prepare(`
    SELECT COUNT(*) as c FROM auth_events
    WHERE event_type = 'login_failure' AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const uploadSuccessToday = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'upload_completed' AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const uploadFailToday = (db.prepare(`
    SELECT COUNT(*) as c FROM usage_events
    WHERE event_type = 'upload_failed' AND created_at > datetime('now', '-1 day')
  `).get() as any).c;

  const recentlyActive = (db.prepare(`
    SELECT COUNT(DISTINCT user_id) as c FROM usage_events
    WHERE user_id IS NOT NULL AND created_at > datetime('now', '-15 minutes')
  `).get() as any).c;

  res.json({
    activeUsersToday, activeUsers7d, activeUsers30d,
    pageViewsToday, pageViews7d, pageViews30d,
    postsToday, commentsToday, likesToday,
    loginSuccessToday, loginFailToday,
    uploadSuccessToday, uploadFailToday,
    recentlyActive,
  });
});

// GET /api/admin/analytics/peak-hours
router.get('/analytics/peak-hours', requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour, COUNT(*) as count
    FROM usage_events
    WHERE created_at > datetime('now', '-7 days')
    GROUP BY hour
    ORDER BY count DESC
  `).all() as Array<{ hour: number; count: number }>;

  const peakHours = rows;

  // Suggested announcement windows = 1h before top hours (top 3 unique contiguous windows)
  const topHours = rows.slice(0, 3).map(r => r.hour);
  const suggestedAnnouncementWindows = topHours.map(h => {
    const start = ((h - 1 + 24) % 24).toString().padStart(2, '0');
    const end = ((h + 1) % 24).toString().padStart(2, '0');
    return `${start}:00–${end}:00`;
  });

  // Quiet windows = bottom 3 hours
  const bottomHours = [...rows].sort((a, b) => a.count - b.count).slice(0, 3).map(r => r.hour);
  const quietWindows = bottomHours.map(h => {
    const start = h.toString().padStart(2, '0');
    const end = ((h + 3) % 24).toString().padStart(2, '0');
    return `${start}:00–${end}:00`;
  });

  res.json({ peakHours, suggestedAnnouncementWindows, quietWindows });
});

// GET /api/admin/analytics/feature-usage
router.get('/analytics/feature-usage', requireAuth, requireAdmin, (_req, res) => {
  const db = getDb();

  const featureAreas = db.prepare(`
    SELECT feature_area as area, COUNT(*) as count
    FROM usage_events
    WHERE feature_area IS NOT NULL AND created_at > datetime('now', '-30 days')
    GROUP BY feature_area
    ORDER BY count DESC
  `).all() as Array<{ area: string; count: number }>;

  res.json({ featureAreas });
});

// ─── Backup Routes ───
// All paths and commands are fixed — no user input ever reaches the shell.

const BACKUP_DIR = '/home/brock/backups/refugecloud-db';
const BACKUP_RETENTION_DAYS = 14;
const BACKUP_SCRIPT = path.resolve(__dirname, '../../scripts/backup-db.sh');
const UPLOADS_DIR = '/home/brock/social-site/uploads';
const UPLOAD_BACKUP_DIR = '/home/brock/backups/refugecloud-uploads';
const UPLOAD_BACKUP_RETENTION_DAYS = 14;
const UPLOAD_BACKUP_SCRIPT = path.resolve(__dirname, '../../scripts/backup-uploads.sh');
const UPLOAD_BACKUP_TIMER = 'refugecloud-uploads-backup.timer';
const UPLOAD_BACKUP_SERVICE = 'refugecloud-uploads-backup.service';

type BackupFileInfo = { name: string; fullPath: string; sizeBytes: number; mtime: number };

/** Run a fixed command safely. Returns trimmed stdout or 'unavailable' on any error/timeout. */
function spawnSafe(cmd: string, args: string[], timeoutMs = 5000): string {
  try {
    const r = spawnSync(cmd, args, { timeout: timeoutMs, encoding: 'utf8' });
    if (r.error) return 'unavailable';
    return (r.stdout || '').trim() || 'unavailable';
  } catch {
    return 'unavailable';
  }
}

function listBackupFiles(dir: string, prefix: string, suffix: string): BackupFileInfo[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.startsWith(prefix) && f.endsWith(suffix))
    .map(name => {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      return { name, fullPath, sizeBytes: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function backupSummary(file: BackupFileInfo | undefined): any {
  if (!file) return null;
  const ageHours = Math.round(((Date.now() - file.mtime) / 3_600_000) * 10) / 10;
  return { filename: file.name, sizeBytes: file.sizeBytes, mtimeMs: file.mtime, ageHours };
}

function directoryStats(dir: string): { exists: boolean; fileCount: number; totalSizeBytes: number } {
  if (!fs.existsSync(dir)) return { exists: false, fileCount: 0, totalSizeBytes: 0 };
  let fileCount = 0;
  let totalSizeBytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: string[] = [];
    try { entries = fs.readdirSync(current); } catch { continue; }
    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) stack.push(fullPath);
        else if (stat.isFile()) { fileCount++; totalSizeBytes += stat.size; }
      } catch { /* non-fatal */ }
    }
  }
  return { exists: true, fileCount, totalSizeBytes };
}

function nextScheduledRunFromTimer(timerListRaw: string): string {
  if (timerListRaw === 'unavailable') return 'unavailable';
  const parts = timerListRaw.split(/\s+/);
  return parts.length >= 4 ? `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}` : 'unavailable';
}

function safeServiceLog(raw: string): string {
  if (!raw || raw === 'unavailable') return raw || 'unavailable';
  return raw
    .split(/\r?\n/)
    .slice(-20)
    .map(line => line.slice(0, 240))
    .join('\n')
    .slice(0, 3000);
}

function logAdminBackupRun(
  eventType: 'admin_backup_run' | 'admin_upload_backup_run',
  adminId: number,
  success: boolean,
  reason: string,
  durationMs: number,
): void {
  logAuthEvent({
    eventType,
    userId: adminId,
    success,
    reason,
    adminActorId: adminId,
    meta: { durationMs },
  });
}

// GET /api/admin/backups/status — backup directory health, latest file info, timer status
router.get('/backups/status', requireAuth, requireAdmin, (_req, res) => {
  if (!runtimeStorage.isProduction) {
    res.status(503).json({ error: 'Production backup controls are disabled outside production.' });
    return;
  }

  // ── 1. Enumerate backup files ────────────────────────────────────────────
  let backupDirExists = false;
  let backupFiles: BackupFileInfo[] = [];
  let uploadBackupDirExists = false;
  let uploadBackupFiles: BackupFileInfo[] = [];

  try {
    backupDirExists = fs.existsSync(BACKUP_DIR);
    if (backupDirExists) backupFiles = listBackupFiles(BACKUP_DIR, 'refugecloud-social-', '.db');
  } catch { /* non-fatal */ }

  try {
    uploadBackupDirExists = fs.existsSync(UPLOAD_BACKUP_DIR);
    if (uploadBackupDirExists) uploadBackupFiles = listBackupFiles(UPLOAD_BACKUP_DIR, 'refugecloud-uploads-', '.tar.gz');
  } catch { /* non-fatal */ }

  // ── 2. Latest backup metadata ─────────────────────────────────────────────
  let latestBackup: any = null;
  let integrityCheck: 'ok' | 'failed' | 'unavailable' = 'unavailable';

  if (backupFiles.length > 0) {
    const latest = backupFiles[0];
    latestBackup = backupSummary(latest);

    // Integrity check on backup file only — fixed command, no user input in path
    try {
      const r = spawnSync('sqlite3', [latest.fullPath, 'PRAGMA integrity_check;'], {
        timeout: 15_000, encoding: 'utf8',
      });
      if (r.error || r.status !== 0) {
        integrityCheck = 'failed';
      } else {
        integrityCheck = (r.stdout || '').trim() === 'ok' ? 'ok' : 'failed';
      }
    } catch { integrityCheck = 'unavailable'; }
  }

  const totalSizeBytes = backupFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
  const uploadBackupTotalSizeBytes = uploadBackupFiles.reduce((sum, f) => sum + f.sizeBytes, 0);
  const uploadsSourceStats = directoryStats(UPLOADS_DIR);
  const uploadBackupScriptExists = fs.existsSync(UPLOAD_BACKUP_SCRIPT);
  const uploadsCovered = uploadBackupScriptExists && uploadBackupFiles.length > 0;

  // ── 3. Systemd timer / service status (fixed commands only) ───────────────
  const timerActive     = spawnSafe('systemctl', ['is-active', 'refugecloud-db-backup.timer']);
  const timerListRaw    = spawnSafe('systemctl', ['list-timers', '--no-pager', '--no-legend', 'refugecloud-db-backup.timer']);
  const lastServiceLog  = spawnSafe('journalctl', ['-u', 'refugecloud-db-backup.service', '-n', '15', '--no-pager', '--output=cat']);
  const uploadTimerActive    = spawnSafe('systemctl', ['is-active', UPLOAD_BACKUP_TIMER]);
  const uploadTimerListRaw   = spawnSafe('systemctl', ['list-timers', '--no-pager', '--no-legend', UPLOAD_BACKUP_TIMER]);
  const uploadLastServiceLog = spawnSafe('journalctl', ['-u', UPLOAD_BACKUP_SERVICE, '-n', '15', '--no-pager', '--output=cat']);

  // Parse "NEXT" datetime from list-timers: first 4 whitespace tokens are Day Date Time TZ
  const nextScheduledRun = nextScheduledRunFromTimer(timerListRaw);
  const uploadNextScheduledRun = nextScheduledRunFromTimer(uploadTimerListRaw);

  res.json({
    backupDirExists,
    backupDir: BACKUP_DIR,
    retentionDays: BACKUP_RETENTION_DAYS,
    backupCount: backupFiles.length,
    totalSizeBytes,
    latestBackup,
    integrityCheck,
    timerActive,
    nextScheduledRun,
    lastServiceLog: safeServiceLog(lastServiceLog),
    uploadsCovered,
    uploadBackups: {
      sourceDir: UPLOADS_DIR,
      sourceDirExists: uploadsSourceStats.exists,
      sourceFileCount: uploadsSourceStats.fileCount,
      sourceSizeBytes: uploadsSourceStats.totalSizeBytes,
      backupDirExists: uploadBackupDirExists,
      backupDir: UPLOAD_BACKUP_DIR,
      retentionDays: UPLOAD_BACKUP_RETENTION_DAYS,
      backupCount: uploadBackupFiles.length,
      totalSizeBytes: uploadBackupTotalSizeBytes,
      latestBackup: backupSummary(uploadBackupFiles[0]),
      backupScriptExists: uploadBackupScriptExists,
      uploadsCovered,
      timerName: UPLOAD_BACKUP_TIMER,
      serviceName: UPLOAD_BACKUP_SERVICE,
      timerActive: uploadTimerActive,
      nextScheduledRun: uploadNextScheduledRun,
      lastServiceLog: safeServiceLog(uploadLastServiceLog),
    },
  });
});

// POST /api/admin/backups/run — run the backup script (fixed command, no user args)
router.post('/backups/run', requireAuth, requireAdmin, (req, res) => {
  if (!runtimeStorage.isProduction) {
    res.status(503).json({ error: 'Production backup controls are disabled outside production.' });
    return;
  }

  const startMs = Date.now();
  const adminId = (req as any).user.id;
  try {
    if (!fs.existsSync(BACKUP_SCRIPT)) {
      logAdminBackupRun('admin_backup_run', adminId, false, 'script_missing', Date.now() - startMs);
      res.status(500).json({ ok: false, error: 'Backup script not found at expected path.' });
      return;
    }
    const result = spawnSync('bash', [BACKUP_SCRIPT], {
      timeout: 120_000, // 2 minutes max
      encoding: 'utf8',
      env: { ...process.env },
    });
    const durationMs = Date.now() - startMs;
    if (result.error) {
      logAdminBackupRun('admin_backup_run', adminId, false, 'launch_failed', durationMs);
      res.json({ ok: false, error: result.error.message, durationMs });
      return;
    }
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    if (result.status !== 0) {
      logAdminBackupRun('admin_backup_run', adminId, false, 'script_failed', durationMs);
      res.json({ ok: false, error: stderr || 'Script exited with non-zero status.', output: stdout, durationMs });
      return;
    }
    logAdminBackupRun('admin_backup_run', adminId, true, 'completed', durationMs);
    res.json({ ok: true, output: stdout, durationMs });
  } catch (e: any) {
    logAdminBackupRun('admin_backup_run', adminId, false, 'unexpected_error', Date.now() - startMs);
    res.json({ ok: false, error: e.message || 'Unexpected error.', durationMs: Date.now() - startMs });
  }
});

// POST /api/admin/backups/run-uploads — run the uploads backup script (fixed command, no user args)
router.post('/backups/run-uploads', requireAuth, requireAdmin, (req, res) => {
  if (!runtimeStorage.isProduction) {
    res.status(503).json({ error: 'Production backup controls are disabled outside production.' });
    return;
  }

  const startMs = Date.now();
  const adminId = (req as any).user.id;
  try {
    if (!fs.existsSync(UPLOAD_BACKUP_SCRIPT)) {
      logAdminBackupRun('admin_upload_backup_run', adminId, false, 'script_missing', Date.now() - startMs);
      res.status(500).json({ ok: false, error: 'Upload backup script not found at expected path.' });
      return;
    }
    const result = spawnSync('bash', [UPLOAD_BACKUP_SCRIPT], {
      timeout: 300_000, // 5 minutes max
      encoding: 'utf8',
      env: { ...process.env },
    });
    const durationMs = Date.now() - startMs;
    if (result.error) {
      console.error('[backup-uploads] Script launch error:', result.error.message);
      logAdminBackupRun('admin_upload_backup_run', adminId, false, 'launch_failed', durationMs);
      res.json({ ok: false, error: 'Upload backup timed out or could not start.', durationMs });
      return;
    }
    if (result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      console.error('[backup-uploads] Script failed:', stderr.slice(0, 500) || `status ${result.status}`);
      logAdminBackupRun('admin_upload_backup_run', adminId, false, 'script_failed', durationMs);
      res.json({ ok: false, error: 'Upload backup failed.', durationMs });
      return;
    }
    const latest = backupSummary(listBackupFiles(UPLOAD_BACKUP_DIR, 'refugecloud-uploads-', '.tar.gz')[0]);
    logAdminBackupRun('admin_upload_backup_run', adminId, true, 'completed', durationMs);
    res.json({ ok: true, durationMs, latestBackup: latest });
  } catch (e: any) {
    console.error('[backup-uploads] Unexpected error:', e.message);
    logAdminBackupRun('admin_upload_backup_run', adminId, false, 'unexpected_error', Date.now() - startMs);
    res.json({ ok: false, error: 'Unexpected upload backup error.', durationMs: Date.now() - startMs });
  }
});

export default router;
