import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { isBlockedBetween } from '../visibility.js';

const router = Router();

// POST /api/follows/:userId
router.post('/:userId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const targetId = Number(req.params.userId);
  if (targetId === req.user!.id) { res.status(400).json({ error: 'Cannot follow yourself.' }); return; }

  const exists = getDb().prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!exists) { res.status(404).json({ error: 'User not found.' }); return; }
  if (isBlockedBetween(req.user!.id, targetId)) {
    res.status(403).json({ error: 'Cannot follow this user.' }); return;
  }

  try {
    const db = getDb();
    const followResult = db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)')
      .run(req.user!.id, targetId);

    if (followResult.changes > 0) {
      db.prepare(`
        INSERT INTO notifications (user_id, actor_id, type)
        SELECT ?, ?, 'follow'
        WHERE NOT EXISTS (
          SELECT 1 FROM notifications
          WHERE user_id = ? AND actor_id = ? AND type = 'follow'
            AND created_at > datetime('now', '-24 hours')
        )
      `).run(targetId, req.user!.id, targetId, req.user!.id);
    }

    res.json({ ok: true, following: true });
  } catch (err: any) {
    console.error('[follows] Failed to follow user:', err.message);
    res.status(500).json({ error: 'Could not follow user.' });
  }
});

// DELETE /api/follows/:userId
router.delete('/:userId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  getDb().prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
    .run(req.user!.id, Number(req.params.userId));
  res.json({ ok: true, following: false });
});

export default router;
