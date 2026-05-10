import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';

const router = Router();

// GET /api/feed?mode=following&limit=50&offset=0
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  try {
    const mode = (req.query.mode as string) || 'following';
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;
    let rows: any[];

    if (mode === 'following' && req.user) {
      // Posts from followed users + own posts
      rows = getDb().prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0
          AND (p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(req.user.id, req.user.id, limit, offset);
    } else {
      // Global chronological feed
      rows = getDb().prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    }

    const posts = rows.map((r: any) => enrichPost(r, req.user?.id));
    res.json({ posts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
