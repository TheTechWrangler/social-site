import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';
import { canInteractWithPost } from '../visibility.js';
import { logUsage } from '../usageEvents.js';
import { createRepostNotification } from '../notificationService.js';

const router = Router();

// POST /api/reposts/:postId
router.post('/:postId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const originalId = Number(req.params.postId);
  const original = getDb().prepare('SELECT id FROM posts WHERE id = ? AND parent_id IS NULL').get(originalId) as any;
  if (!original) { res.status(404).json({ error: 'Post not found.' }); return; }
  const access = canInteractWithPost(req.user as any, originalId);
  if (!access.ok) { res.status(access.status || 403).json({ error: access.error }); return; }

  const createRepost = getDb().transaction(() => {
    const result = getDb().prepare('INSERT OR IGNORE INTO posts (user_id, content, repost_of) VALUES (?, ?, ?)')
      .run(req.user!.id, '', originalId);
    const postId = result.changes === 1
      ? Number(result.lastInsertRowid)
      : (getDb().prepare(`
          SELECT id FROM posts WHERE user_id = ? AND repost_of = ? AND parent_id IS NULL
        `).get(req.user!.id, originalId) as { id: number } | undefined)?.id;
    if (!postId) throw new Error('Repost idempotency invariant failed.');
    createRepostNotification(access.post.user_id, req.user!.id, originalId);
    return { postId, replayed: result.changes === 0 };
  });
  const result = createRepost();

  const row = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(result.postId);

  if (!result.replayed) logUsage({ eventType: 'repost_created', userId: req.user!.id, featureArea: 'feed' });
  res.status(result.replayed ? 200 : 201).json({ post: enrichPost(row, req.user as any), replayed: result.replayed });
});

export default router;
