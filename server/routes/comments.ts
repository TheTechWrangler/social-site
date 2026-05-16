import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';
import { canInteractWithPost, canViewPost } from '../visibility.js';
import { logUsage } from '../usageEvents.js';

const router = Router();

const COMMENT_MAX_LENGTH = 5000;

// POST /api/comments/:postId
router.post('/:postId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const parentId = Number(req.params.postId);
  const { content } = req.body;
  if (!content?.trim()) { res.status(400).json({ error: 'Content required.' }); return; }
  if (content.trim().length > COMMENT_MAX_LENGTH) {
    res.status(400).json({ error: `Comment must be ${COMMENT_MAX_LENGTH} characters or fewer.` }); return;
  }

  const parent = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(parentId) as any;
  if (!parent) { res.status(404).json({ error: 'Post not found.' }); return; }
  const access = canInteractWithPost(req.user as any, parentId);
  if (!access.ok) { res.status(access.status || 403).json({ error: access.error }); return; }

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

  logUsage({ eventType: 'comment_created', userId: req.user!.id, featureArea: 'feed' });
  res.status(201).json({ comment: enrichPost(row, req.user!.id) });
});

// GET /api/comments/:postId
router.get('/:postId', optionalAuth, (req: AuthRequest, res) => {
  const parentId = Number(req.params.postId);
  if (!canViewPost(req.user as any, parentId)) { res.status(404).json({ error: 'Post not found.' }); return; }
  const rows = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.parent_id = ? AND p.hidden = 0 ORDER BY p.created_at ASC
  `).all(parentId);

  res.json({ comments: rows.filter((r: any) => canViewPost(req.user as any, r.id)).map((r: any) => enrichPost(r, req.user?.id)) });
});

export default router;
