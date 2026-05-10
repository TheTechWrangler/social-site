import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware.js';

const router = Router();

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
  getDb().prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/posts/:id/unhide
router.post('/posts/:id/unhide', requireAuth, requireAdmin, (req, res) => {
  getDb().prepare('UPDATE posts SET hidden = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/reports
router.get('/reports', requireAuth, requireAdmin, (_req, res) => {
  const rows = getDb().prepare(`
    SELECT r.*, u.username as reporter_name, p.content as post_content
    FROM reports r JOIN users u ON r.reporter_id = u.id LEFT JOIN posts p ON r.post_id = p.id
    ORDER BY r.created_at DESC LIMIT 50
  `).all();
  res.json({ reports: rows });
});

// POST /api/admin/reports
router.post('/reports', requireAuth, (req: AuthRequest, res) => {
  const { postId, reason } = req.body;
  if (!postId || !reason) { res.status(400).json({ error: 'postId and reason required.' }); return; }
  getDb().prepare('INSERT INTO reports (reporter_id, post_id, reason) VALUES (?, ?, ?)')
    .run(req.user!.id, postId, reason);
  res.status(201).json({ ok: true });
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
