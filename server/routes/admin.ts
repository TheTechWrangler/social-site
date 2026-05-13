import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware.js';

const router = Router();
const REPORT_ERROR = 'Please select a reason and briefly explain the problem.';
const REPORT_REASONS = new Set(['Spam', 'Harassment', 'Hate or abuse', 'Sexual content', 'Violence or threats', 'Scam or unsafe link', 'Other']);

// GET /api/admin/users
router.get('/users', requireAuth, requireAdmin, (_req, res) => {
  const rows = getDb().prepare('SELECT id, username, display_name, email, role, banned, is_verified, profile_visibility, feed_exposure, created_at FROM users ORDER BY id').all();
  res.json({ users: rows });
});

// POST /api/admin/users/:id/ban
router.post('/users/:id/ban', requireAuth, requireAdmin, (req, res) => {
  getDb().prepare('UPDATE users SET banned = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/users/:id/unban
router.post('/users/:id/unban', requireAuth, requireAdmin, (req, res) => {
  getDb().prepare('UPDATE users SET banned = 0 WHERE id = ?').run(req.params.id);
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
  const result = getDb().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(req.params.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Content not found.' }); return; }
  res.json({ ok: true });
});

// POST /api/admin/posts/:id/unhide
router.post('/posts/:id/unhide', requireAuth, requireAdmin, (req, res) => {
  getDb().prepare('UPDATE posts SET hidden = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/reports
router.get('/reports', requireAuth, requireAdmin, (req, res) => {
  const statusFilter = req.query.status as string;
  let sql = `
    SELECT r.*, u.username as reporter_name, p.content as post_content, p.user_id as post_author_id,
      p.parent_id as post_parent_id, pu.username as post_author_name, p.hidden as post_hidden
    FROM reports r JOIN users u ON r.reporter_id = u.id LEFT JOIN posts p ON r.post_id = p.id LEFT JOIN users pu ON p.user_id = pu.id
  `;
  if (statusFilter && ['open','resolved','dismissed'].includes(statusFilter)) {
    sql += ' WHERE r.status = ?';
    sql += ' ORDER BY r.created_at DESC LIMIT 50';
    const rows = getDb().prepare(sql).all(statusFilter);
    res.json({ reports: rows });
  } else {
    sql += ' ORDER BY r.created_at DESC LIMIT 50';
    const rows = getDb().prepare(sql).all();
    res.json({ reports: rows });
  }
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
  if (!REPORT_REASONS.has(reason) && reason.length < 2) { res.status(400).json({ error: REPORT_ERROR }); return; }
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

  const target = getDb().prepare('SELECT id, role FROM users WHERE id = ?').get(targetId) as any;
  if (!target) { res.status(404).json({ error: 'User not found.' }); return; }

  if (target.role === 'admin') {
    const adminCount = (getDb().prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as any).c;
    if (adminCount <= 1) {
      res.status(400).json({ error: 'Cannot delete the last admin account.' }); return;
    }
  }

  // reports.resolved_by has no cascade — null it first to avoid dangling FK
  getDb().prepare('UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?').run(targetId);

  // All other related data cascades via ON DELETE CASCADE on the users FK
  getDb().prepare('DELETE FROM users WHERE id = ?').run(targetId);

  res.json({ ok: true });
});

// POST /api/admin/users/:id/verify
router.post('/users/:id/verify', requireAuth, requireAdmin, (req, res) => {
  getDb().prepare("UPDATE users SET is_verified = 1, verified_at = datetime('now'), verified_by = ? WHERE id = ?")
    .run((req as any).user.id, req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/users/:id/unverify
router.post('/users/:id/unverify', requireAuth, requireAdmin, (req, res) => {
  getDb().prepare('UPDATE users SET is_verified = 0, verified_at = NULL, verified_by = NULL WHERE id = ? AND role != ?')
    .run(req.params.id, 'admin');
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

  // Safety: don't demote yourself if you're the only admin
  if (targetId === adminId && role !== 'admin') {
    const adminCount = (getDb().prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin'").get() as any).c;
    if (adminCount <= 1) {
      res.status(400).json({ error: 'Cannot remove the last admin.' }); return;
    }
  }

  getDb().prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
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
  const { gameId, name, description, connectionHost, connectionPort, platform, status, maxPlayers,
    currentPlayers, isFeatured, isActive, joinInstructions, rulesSummary, discordUrl, websiteUrl, serverType, playStyle, regionOrTimezone } = req.body;
  if (!gameId || !name) { res.status(400).json({ error: 'gameId and name required.' }); return; }
  const r = getDb().prepare(`INSERT INTO game_servers (game_id, name, description, connection_host, connection_port, platform, status, max_players, current_players, is_featured, is_active, join_instructions, rules_summary, discord_url, website_url, server_type, play_style, region_or_timezone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(gameId, name, description||'', connectionHost||'', connectionPort||null, platform||'', status||'unknown',
      maxPlayers||null, currentPlayers||0, isFeatured?1:0, isActive!==undefined?isActive:1,
      joinInstructions||'', rulesSummary||'', discordUrl||'', websiteUrl||'', serverType||'', playStyle||'', regionOrTimezone||'');
  const server = getDb().prepare('SELECT * FROM game_servers WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ server });
});

router.patch('/game-servers/:id', requireAuth, requireAdmin, (req, res) => {
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
  res.json({ ok: true });
});

router.delete('/game-servers/:id', requireAuth, requireAdmin, (req, res) => {
  getDb().prepare('DELETE FROM game_servers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
