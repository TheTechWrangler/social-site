import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';

const router = Router();

// POST /api/reposts/:postId
router.post('/:postId', requireAuth, (req: AuthRequest, res) => {
  const originalId = Number(req.params.postId);
  const original = getDb().prepare('SELECT id FROM posts WHERE id = ? AND parent_id IS NULL').get(originalId) as any;
  if (!original) { res.status(404).json({ error: 'Post not found.' }); return; }

  const result = getDb().prepare('INSERT INTO posts (user_id, content, repost_of) VALUES (?, ?, ?)')
    .run(req.user!.id, '', originalId);

  const row = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({ post: enrichPost(row, req.user!.id) });
});

export default router;
