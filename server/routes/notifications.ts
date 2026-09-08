import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, type AuthRequest } from '../middleware.js';
import { canViewPost, userVisibilitySql } from '../visibility.js';

const router = Router();

// GET /api/notifications
router.get('/', requireAuth, (req: AuthRequest, res) => {
  const actorVisibility = userVisibilitySql(req.user as any, 'u', 'identity');
  const rows = getDb().prepare(`
    SELECT n.*,
      u.username as actor_username, u.display_name as actor_name, u.avatar_url as actor_avatar,
      p.parent_id as post_parent_id,
      substr(p.content, 1, 120) as post_snippet
    FROM notifications n
    JOIN users u ON n.actor_id = u.id
    LEFT JOIN posts p ON n.post_id = p.id
    WHERE n.user_id = ? AND ${actorVisibility.sql}
    ORDER BY n.created_at DESC LIMIT 50
  `).all(req.user!.id, ...actorVisibility.params) as any[];
  res.json({
    notifications: rows.map(row => {
      if (row.post_id && !canViewPost(req.user as any, row.post_id)) {
        return { ...row, post_id: null, post_parent_id: null, post_snippet: null };
      }
      return row;
    }),
  });
});

// GET /api/notifications/unread-count
router.get('/unread-count', requireAuth, (req: AuthRequest, res) => {
  const actorVisibility = userVisibilitySql(req.user as any, 'u', 'identity');
  const row = getDb().prepare(`
    SELECT COUNT(*) as c
    FROM notifications n JOIN users u ON n.actor_id = u.id
    WHERE n.user_id = ? AND n.read = 0 AND ${actorVisibility.sql}
  `).get(req.user!.id, ...actorVisibility.params) as any;
  res.json({ count: row?.c ?? 0 });
});

// POST /api/notifications/read-all
router.post('/read-all', requireAuth, (req: AuthRequest, res) => {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user!.id);
  res.json({ ok: true });
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', requireAuth, (req: AuthRequest, res) => {
  const result = getDb().prepare(
    'UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?'
  ).run(Number(req.params.id), req.user!.id);
  if (result.changes === 0) { res.status(404).json({ error: 'Notification not found.' }); return; }
  res.json({ ok: true });
});

export default router;
