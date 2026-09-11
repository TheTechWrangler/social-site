import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';
import { canInteractWithPost, canViewPost, userVisibilitySql } from '../visibility.js';
import { logUsage } from '../usageEvents.js';
import { createCommentNotification } from '../notificationService.js';
import { validatePostContent } from '../postValidation.js';
import { validationErrorMessage } from '../requestValidation.js';

const router = Router();

// POST /api/comments/:postId
router.post('/:postId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const parentId = Number(req.params.postId);
  let content: string;
  try {
    content = validatePostContent(req.body?.content);
  } catch (error) {
    const message = validationErrorMessage(error);
    if (!message) throw error;
    res.status(400).json({ error: message }); return;
  }

  const parent = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(parentId) as any;
  if (!parent) { res.status(404).json({ error: 'Post not found.' }); return; }
  const access = canInteractWithPost(req.user as any, parentId);
  if (!access.ok) { res.status(access.status || 403).json({ error: access.error }); return; }

  const createComment = getDb().transaction(() => {
    const result = getDb().prepare('INSERT INTO posts (user_id, content, parent_id) VALUES (?, ?, ?)')
      .run(req.user!.id, content, parentId);
    const commentId = Number(result.lastInsertRowid);
    createCommentNotification(parent.user_id, req.user!.id, commentId);
    return commentId;
  });
  const commentId = createComment();

  const row = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(commentId);

  logUsage({ eventType: 'comment_created', userId: req.user!.id, featureArea: 'feed' });
  res.status(201).json({ comment: enrichPost(row, req.user as any) });
});

// GET /api/comments/:postId
router.get('/:postId', optionalAuth, (req: AuthRequest, res) => {
  const parentId = Number(req.params.postId);
  if (!canViewPost(req.user as any, parentId)) { res.status(404).json({ error: 'Post not found.' }); return; }
  const authorVisibility = userVisibilitySql(req.user as any, 'u', 'public-context');
  const rows = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.parent_id = ? AND p.hidden = 0 AND ${authorVisibility.sql}
    ORDER BY p.created_at ASC
  `).all(parentId, ...authorVisibility.params);

  res.json({ comments: rows.map((r: any) => enrichPost(r, req.user as any)) });
});

export default router;
