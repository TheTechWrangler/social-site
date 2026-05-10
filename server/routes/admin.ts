import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware.js';

const router = Router();

// GET /api/admin/users
router.get('/users', requireAuth, requireAdmin, (_req, res) => {
  const rows = getDb().prepare('SELECT id, username, display_name, email, role, banned, created_at FROM users ORDER BY id').all();
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

export default router;
