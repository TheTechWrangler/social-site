import { Router } from 'express';
import { getDb } from '../database.js';
import { optionalAuth, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';

const router = Router();

// GET /api/feed?exposure=friends_only|mixed|everyone&limit=50&offset=0
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;
    const db = getDb();
    let rows: any[];

    // Determine exposure: query param > user setting > default mixed
    let exposure = (req.query.exposure as string) || 'mixed';
    if (['friends_only', 'mixed', 'everyone'].indexOf(exposure) === -1) {
      if (req.user) {
        const u = db.prepare('SELECT feed_exposure FROM users WHERE id = ?').get(req.user.id) as any;
        exposure = u?.feed_exposure || 'mixed';
      } else {
        exposure = 'mixed';
      }
    }

    if ((exposure === 'friends_only' || exposure === 'mixed') && req.user) {
      // Friends/following posts + own posts
      const friendLimit = exposure === 'friends_only' ? limit : Math.ceil(limit * 0.75);
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0
          AND (p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(req.user.id, req.user.id, friendLimit, offset);

      // Mixed: add friends-of-friends / extended circle posts
      if (exposure === 'mixed') {
        const publicLimit = limit - rows.length;
        if (publicLimit > 0) {
          const publicRows = db.prepare(`
            SELECT DISTINCT p.*, u.username, u.display_name, u.avatar_url
            FROM posts p JOIN users u ON p.user_id = u.id
            WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0 AND u.is_verified = 1
              AND p.user_id != ?
              AND p.user_id NOT IN (SELECT following_id FROM follows WHERE follower_id = ?)
              AND p.user_id IN (
                SELECT following_id FROM follows
                WHERE follower_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
              )
            ORDER BY p.created_at DESC LIMIT ?
          `).all(req.user.id, req.user.id, req.user.id, publicLimit);
          rows = [...rows, ...publicRows].sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));
        }
      }
    } else {
      // Everyone: all public verified posts (or unauthenticated)
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0 AND u.is_verified = 1
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    }

    const posts = rows.map((r: any) => enrichPost(r, req.user?.id));
    res.json({ posts, exposure });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
