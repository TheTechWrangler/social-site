import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, type AuthRequest } from '../middleware.js';

const router = Router();

// GET /api/notifications
router.get('/', requireAuth, (req: AuthRequest, res) => {
  const rows = getDb().prepare(`
    SELECT n.*, u.username as actor_username, u.display_name as actor_name, u.avatar_url as actor_avatar
    FROM notifications n JOIN users u ON n.actor_id = u.id
    WHERE n.user_id = ? ORDER BY n.created_at DESC LIMIT 50
  `).all(req.user!.id);
  res.json({ notifications: rows });
});

// GET /api/notifications/unread-count
router.get('/unread-count', requireAuth, (req: AuthRequest, res) => {
  const row = getDb().prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id = ? AND read = 0').get(req.user!.id) as any;
  res.json({ count: row?.c ?? 0 });
});

// POST /api/notifications/read-all
router.post('/read-all', requireAuth, (req: AuthRequest, res) => {
  getDb().prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user!.id);
  res.json({ ok: true });
});

export default router;
