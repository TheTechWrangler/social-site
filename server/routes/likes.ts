import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, type AuthRequest } from '../middleware.js';

const router = Router();

// POST /api/likes/:postId
router.post('/:postId', requireAuth, (req: AuthRequest, res) => {
  const postId = Number(req.params.postId);
  const post = getDb().prepare('SELECT id, user_id FROM posts WHERE id = ?').get(postId) as any;
  if (!post) { res.status(404).json({ error: 'Post not found.' }); return; }

  getDb().prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user!.id, postId);

  if (post.user_id !== req.user!.id) {
    getDb().prepare(`INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'like', ?)`)
      .run(post.user_id, req.user!.id, postId);
  }

  const count = (getDb().prepare('SELECT COUNT(*) as c FROM likes WHERE post_id = ?').get(postId) as any).c;
  res.json({ ok: true, liked: true, likeCount: count });
});

// DELETE /api/likes/:postId
router.delete('/:postId', requireAuth, (req: AuthRequest, res) => {
  const postId = Number(req.params.postId);
  getDb().prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user!.id, postId);

  const count = (getDb().prepare('SELECT COUNT(*) as c FROM likes WHERE post_id = ?').get(postId) as any).c;
  res.json({ ok: true, liked: false, likeCount: count });
});

export default router;
