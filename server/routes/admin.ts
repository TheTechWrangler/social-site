import { auditOperation } from '../operationalAudit.js';
import { Router } from 'express';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from '../database.js';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware.js';
import { logAuthEvent } from '../authEvents.js';
import { logUsage } from '../usageEvents.js';
import { isGoogleConfigured, isSteamConfigured } from '../authProviders.js';
import { getStorageConfig } from '../config.js';
import { boundedInteger } from '../pagination.js';
import { validateGameServerCreate, validateGameServerPatch } from '../gameServerValidation.js';
import { positiveIntegerParam, validationErrorMessage } from '../requestValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeStorage = getStorageConfig();

// Cache package version once at startup — avoids per-request disk read in system-health.
let APP_VERSION = 'unknown';
try {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  APP_VERSION = pkg.version || 'unknown';
} catch { /* non-fatal — version stays 'unknown' */ }

const router = Router();

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

function parsePageLimit(query: any, defaultLimit: number, maxLimit: number): { page: number; limit: number; offset: number } {
  const limit = boundedInteger(query.limit, defaultLimit, 1, maxLimit);
  const page = boundedInteger(query.page, 1, 1, Math.floor(100000 / limit) + 1);
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

  db.transaction(() => {
    db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(targetId);
    auditOperation(db, 'user.banned', adminId, 'user', targetId);
  })();
  logAuthEvent({ eventType: 'admin_ban', userId: targetId, adminActorId: adminId, targetUserId: targetId });
  res.json({ ok: true });
});

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const targetId = Number(req.params.id);
  const changed = getDb().transaction(() => {
    const changed = getDb().prepare('UPDATE users SET banned = 0 WHERE id = ?').run(targetId).changes;
    if (changed) auditOperation(getDb(), 'user.unbanned', adminId, 'user', targetId);
    return changed;
  })();
  if (!changed) { res.status(404).json({ error: 'User not found.' }); return; }
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
  const result = getDb().transaction(() => {
    const result = getDb().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(postId);
    if (result.changes) auditOperation(getDb(), 'post.hidden', adminId, 'post', postId);
    return result;
  })();
  if (result.changes === 0) { res.status(404).json({ error: 'Content not found.' }); return; }
  logAuthEvent({ eventType: 'admin_hide_post', userId: adminId, adminActorId: adminId, meta: { postId } });
  res.json({ ok: true });
});

// POST /api/admin/posts/:id/unhide
router.post('/posts/:id/unhide', requireAuth, requireAdmin, (req, res) => {
  const adminId = (req as any).user.id;
  const postId = Number(req.params.id);
  const result = getDb().transaction(() => {
    const result = getDb().prepare('UPDATE posts SET hidden = 0 WHERE id = ?').run(postId);
    if (result.changes) auditOperation(getDb(), 'post.unhidden', adminId, 'post', postId);
    return result;
  })();
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
    auditOperation(db, 'report.updated', (req as any).user.id, 'report', report.id);
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

  // Account deletion must not accidentally delete groups and other members'
  // group-scoped content through the owner FK cascade. An administrator must
  // explicitly transfer or delete every owned group first.
  const ownedGroups = getDb().prepare(`
    SELECT g.id, g.name,
      (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
      (SELECT COUNT(*) FROM posts p WHERE p.group_id = g.id) AS post_count
    FROM groups_table g WHERE g.owner_id = ? ORDER BY g.id
  `).all(targetId) as any[];
  if (ownedGroups.length > 0) {
    res.status(409).json({
      error: 'Resolve or delete groups owned by this user before deleting the account.',
      ownedGroups: ownedGroups.map(group => ({
        id: group.id,
        name: group.name,
        memberCount: group.member_count,
        groupPostCount: group.post_count,
      })),
    });
    return;
  }

  const deleteAccount = getDb().transaction(() => {
    // Revalidate under the write reservation, including other SQLite writers.
    if (getDb().prepare('SELECT 1 FROM groups_table WHERE owner_id = ? LIMIT 1').get(targetId)) {
      throw new Error('Account acquired group ownership; resolve ownership before deletion.');
    }
    // reports.resolved_by has no cascade — null it within the same transaction.
    getDb().prepare('UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?').run(targetId);
    const deleted = getDb().prepare('DELETE FROM users WHERE id = ?').run(targetId);
    if (deleted.changes !== 1) throw new Error('Account deletion did not complete.');
    auditOperation(getDb(), 'user.deleted', viewerId, 'user', targetId);
  });
  deleteAccount.immediate();

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

  db.transaction(() => {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
    auditOperation(db, 'user.role_changed', adminId, 'user', targetId);
  })();
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
  try {
    const adminId = (req as any).user.id;
    const input = validateGameServerCreate(req.body);
    const game = getDb().prepare('SELECT id FROM games WHERE id = ?').get(input.gameId);
    if (!game) { res.status(404).json({ error: 'Game not found.' }); return; }
    if (input.maxPlayers !== null && input.currentPlayers > input.maxPlayers) {
      res.status(400).json({ error: 'currentPlayers cannot exceed maxPlayers.' }); return;
    }
    const r = getDb().prepare(`INSERT INTO game_servers (game_id, name, description, connection_host, connection_port, platform, status, max_players, current_players, is_featured, is_active, join_instructions, rules_summary, discord_url, website_url, server_type, play_style, region_or_timezone)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(input.gameId, input.name, input.description, input.connectionHost, input.connectionPort, input.platform, input.status,
        input.maxPlayers, input.currentPlayers, input.isFeatured ? 1 : 0, input.isActive ? 1 : 0,
        input.joinInstructions, input.rulesSummary, input.discordUrl, input.websiteUrl, input.serverType, input.playStyle, input.regionOrTimezone);
    const server = getDb().prepare('SELECT * FROM game_servers WHERE id = ?').get(r.lastInsertRowid);
    logAuthEvent({ eventType: 'admin_game_server_create', userId: adminId, adminActorId: adminId, meta: { serverId: Number(r.lastInsertRowid), name: input.name } });
    res.status(201).json({ server });
  } catch (error) {
    const message = validationErrorMessage(error);
    if (message) { res.status(400).json({ error: message }); return; }
    throw error;
  }
});

router.patch('/game-servers/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const adminId = (req as any).user.id;
    const serverId = positiveIntegerParam(req.params.id, 'server id');
    const existing = getDb().prepare('SELECT * FROM game_servers WHERE id = ?').get(serverId) as any;
    if (!existing) { res.status(404).json({ error: 'Game server not found.' }); return; }
    const input = validateGameServerPatch(req.body);
    const finalMaxPlayers = input.maxPlayers === undefined ? existing.max_players : input.maxPlayers;
    const finalCurrentPlayers = input.currentPlayers === undefined ? existing.current_players : input.currentPlayers;
    if (finalMaxPlayers !== null && finalCurrentPlayers > finalMaxPlayers) {
      res.status(400).json({ error: 'currentPlayers cannot exceed maxPlayers.' }); return;
    }

    const sets: string[] = [];
    const vals: Array<string | number | null> = [];
    if (input.name !== undefined) { sets.push('name = ?'); vals.push(input.name); }
    if (input.description !== undefined) { sets.push('description = ?'); vals.push(input.description); }
    if (input.connectionHost !== undefined) { sets.push('connection_host = ?'); vals.push(input.connectionHost); }
    if (input.connectionPort !== undefined) { sets.push('connection_port = ?'); vals.push(input.connectionPort); }
    if (input.platform !== undefined) { sets.push('platform = ?'); vals.push(input.platform); }
    if (input.status !== undefined) { sets.push('status = ?'); vals.push(input.status); }
    if (input.maxPlayers !== undefined) { sets.push('max_players = ?'); vals.push(input.maxPlayers); }
    if (input.currentPlayers !== undefined) { sets.push('current_players = ?'); vals.push(input.currentPlayers); }
    if (input.isFeatured !== undefined) { sets.push('is_featured = ?'); vals.push(input.isFeatured ? 1 : 0); }
    if (input.isActive !== undefined) { sets.push('is_active = ?'); vals.push(input.isActive ? 1 : 0); }
    if (input.joinInstructions !== undefined) { sets.push('join_instructions = ?'); vals.push(input.joinInstructions); }
    if (input.rulesSummary !== undefined) { sets.push('rules_summary = ?'); vals.push(input.rulesSummary); }
    if (input.discordUrl !== undefined) { sets.push('discord_url = ?'); vals.push(input.discordUrl); }
    if (input.websiteUrl !== undefined) { sets.push('website_url = ?'); vals.push(input.websiteUrl); }
    if (input.serverType !== undefined) { sets.push('server_type = ?'); vals.push(input.serverType); }
    if (input.playStyle !== undefined) { sets.push('play_style = ?'); vals.push(input.playStyle); }
    if (input.regionOrTimezone !== undefined) { sets.push('region_or_timezone = ?'); vals.push(input.regionOrTimezone); }
    sets.push("updated_at = datetime('now')");
    vals.push(serverId);
    const updated = getDb().prepare(`UPDATE game_servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    if (updated.changes !== 1) { res.status(404).json({ error: 'Game server not found.' }); return; }
    const server = getDb().prepare('SELECT * FROM game_servers WHERE id = ?').get(serverId);
    logAuthEvent({ eventType: 'admin_game_server_update', userId: adminId, adminActorId: adminId, meta: { serverId } });
    res.json({ ok: true, server });
  } catch (error) {
    const message = validationErrorMessage(error);
    if (message) { res.status(400).json({ error: message }); return; }
    throw error;
  }
});

router.delete('/game-servers/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const adminId = (req as any).user.id;
    const serverId = positiveIntegerParam(req.params.id, 'server id');
    const deleted = getDb().prepare('DELETE FROM game_servers WHERE id = ?').run(serverId);
    if (deleted.changes !== 1) { res.status(404).json({ error: 'Game server not found.' }); return; }
    logAuthEvent({ eventType: 'admin_game_server_delete', userId: adminId, adminActorId: adminId, meta: { serverId } });
    res.json({ ok: true });
  } catch (error) {
    const message = validationErrorMessage(error);
    if (message) { res.status(400).json({ error: message }); return; }
    throw error;
  }
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

  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2 hours

  db.transaction(() => {
    db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(targetId);
    db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_by_admin_id) VALUES (?, ?, ?, ?)'
    ).run(targetId, tokenHash, expiresAt, adminId);
    auditOperation(db, 'user.reset_issued', adminId, 'user', targetId);
  }).immediate();

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

// Paired recovery is an offline operator workflow, never a live destructive request.
router.get('/backups/status', requireAuth, requireAdmin, (_req, res) => {
  res.json({ maintenanceRequired: true, formatVersion: 1, physicalGcEnabled: false,
    message: 'Paired database and uploads backups require controlled maintenance. See docs/backups.md.' });
});
for (const route of ['/backups/run', '/backups/run-uploads']) {
  router.post(route, requireAuth, requireAdmin, (_req, res) => {
    res.status(409).json({ error: 'Live standalone backups are retired. Stop storage writers and run the paired recovery command in docs/backups.md.' });
  });
}

export default router;
