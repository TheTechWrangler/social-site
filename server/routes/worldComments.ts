import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified } from '../middleware.js';
import { notMutedByViewerSql, userVisibilitySql } from '../visibility.js';

const router = Router();

// GET /api/world-feed/:itemId/comments
router.get('/:itemId/comments', optionalAuth, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const item = getDb().prepare('SELECT id FROM rss_items WHERE id = ?').get(itemId);
    if (!item) { res.status(404).json({ error: 'RSS item not found.' }); return; }

    const authorVisibility = userVisibilitySql((req as any).user, 'u', 'public-context');
    const notMuted = notMutedByViewerSql((req as any).user, 'u');
    const rows = getDb().prepare(`
      SELECT c.*, u.username, u.display_name, u.avatar_url
      FROM rss_item_comments c JOIN users u ON c.user_id = u.id
      WHERE c.rss_item_id = ? AND c.is_hidden = 0
        AND ${authorVisibility.sql}
        AND ${notMuted.sql}
      ORDER BY c.created_at ASC
    `).all(itemId, ...authorVisibility.params, ...notMuted.params) as any[];

    const visibleCommentIds = new Set(rows.map(r => r.id));
    const comments = rows.map(r => ({
      id: r.id,
      body: r.body,
      userId: r.user_id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      parentId: r.parent_id && visibleCommentIds.has(r.parent_id) ? r.parent_id : null,
      createdAt: r.created_at,
    }));

    res.json({ comments, count: comments.length });
  } catch (err: any) {
    console.error('[world-comments] Load comments error:', err.message);
    res.status(500).json({ error: 'Could not load comments.' });
  }
});

// POST /api/world-feed/:itemId/comments
router.post('/:itemId/comments', requireAuth, requireVerified, (req, res) => {
  try {
    const itemId = Number(req.params.itemId);
    const { body } = req.body;
    if (!body?.trim()) { res.status(400).json({ error: 'Comment body required.' }); return; }

    const item = getDb().prepare('SELECT id FROM rss_items WHERE id = ?').get(itemId);
    if (!item) { res.status(404).json({ error: 'RSS item not found.' }); return; }

    // Sanitize: strip HTML tags, trim
    const cleanBody = body.replace(/<[^>]*>/g, '').trim().slice(0, 2000);
    if (!cleanBody) { res.status(400).json({ error: 'Comment body required after sanitization.' }); return; }

    const user = (req as any).user;
    const result = getDb().prepare(
      'INSERT INTO rss_item_comments (rss_item_id, user_id, body) VALUES (?, ?, ?)'
    ).run(itemId, user.id, cleanBody);

    const row = getDb().prepare(`
      SELECT c.*, u.username, u.display_name, u.avatar_url
      FROM rss_item_comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?
    `).get(result.lastInsertRowid) as any;

    const comment = {
      id: row.id, body: row.body, userId: row.user_id,
      username: row.username, displayName: row.display_name,
      avatarUrl: row.avatar_url, parentId: row.parent_id ?? null,
      createdAt: row.created_at,
    };

    res.status(201).json({ comment });
  } catch (err: any) {
    console.error('[world-comments] Create comment error:', err.message);
    res.status(500).json({ error: 'Could not create comment.' });
  }
});

// DELETE /api/world-feed/comments/:commentId
router.delete('/comments/:commentId', requireAuth, requireVerified, (req, res) => {
  try {
    const commentId = Number(req.params.commentId);
    const user = (req as any).user;
    const comment = getDb().prepare(`
      SELECT id FROM rss_item_comments
      WHERE id = ? AND (user_id = ? OR ? = 'admin')
    `).get(commentId, user.id, user.role) as any;
    if (!comment) { res.status(404).json({ error: 'Comment not found.' }); return; }

    getDb().prepare('DELETE FROM rss_item_comments WHERE id = ?').run(commentId);
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[world-comments] Delete comment error:', err.message);
    res.status(500).json({ error: 'Could not delete comment.' });
  }
});

export default router;
