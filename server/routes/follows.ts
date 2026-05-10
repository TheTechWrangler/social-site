import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, type AuthRequest } from '../middleware.js';

const router = Router();

// POST /api/follows/:userId
router.post('/:userId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.user!.id) { res.status(400).json({ error: 'Cannot follow yourself.' }); return; }

  const exists = getDb().prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!exists) { res.status(404).json({ error: 'User not found.' }); return; }

  try {
    getDb().prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)')
      .run(req.user!.id, targetId);

    // Notification
    getDb().prepare(`INSERT INTO notifications (user_id, actor_id, type) VALUES (?, ?, 'follow')`)
      .run(targetId, req.user!.id);

    res.json({ ok: true, following: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/follows/:userId
router.delete('/:userId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  getDb().prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
    .run(req.user!.id, Number(req.params.userId));
  res.json({ ok: true, following: false });
});

export default router;
