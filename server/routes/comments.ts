import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';

const router = Router();

// POST /api/comments/:postId
router.post('/:postId', requireAuth, (req: AuthRequest, res) => {
  const parentId = Number(req.params.postId);
  const { content } = req.body;
  if (!content?.trim()) { res.status(400).json({ error: 'Content required.' }); return; }

  const parent = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(parentId) as any;
  if (!parent) { res.status(404).json({ error: 'Post not found.' }); return; }

  const result = getDb().prepare('INSERT INTO posts (user_id, content, parent_id) VALUES (?, ?, ?)')
    .run(req.user!.id, content.trim(), parentId);

  if (parent.user_id !== req.user!.id) {
    getDb().prepare(`INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'comment', ?)`)
      .run(parent.user_id, req.user!.id, result.lastInsertRowid);
  }

  const row = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(result.lastInsertRowid);

  res.status(201).json({ comment: enrichPost(row, req.user!.id) });
});

// GET /api/comments/:postId
router.get('/:postId', (req, res) => {
  const rows = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.parent_id = ? ORDER BY p.created_at ASC
  `).all(Number(req.params.postId));

  res.json({ comments: rows.map((r: any) => enrichPost(r)) });
});

export default router;
