import { Router } from 'express';
import { getDb } from '../database.js';
import { optionalAuth, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';
import { getWorldFeed } from '../rssService.js';

const router = Router();

// GET /api/feed?level=everyone|extended|friends|world&limit=50&offset=0
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;
    const db = getDb();

    // Map old exposure values to new levels
    const levelMap: Record<string, string> = {
      friends_only: 'friends', mixed: 'extended', everyone: 'everyone',
      friends: 'friends', extended: 'extended', world: 'world',
    };
    let level = levelMap[(req.query.level as string) || ''] || '';

    if (!['everyone', 'extended', 'friends', 'world'].includes(level)) {
      if (req.user) {
        const u = db.prepare('SELECT feed_exposure FROM users WHERE id = ?').get(req.user.id) as any;
        const raw = u?.feed_exposure || 'extended';
        level = levelMap[raw] || 'extended';
      } else {
        level = 'extended';
      }
    }

    // ─── World Feed mode ───
    if (level === 'world') {
      const items = getWorldFeed({ limit, offset, userId: req.user?.id });
      res.json({ posts: [], worldItems: items, level });
      return;
    }

    // ─── Native post modes ───
    let rows: any[];

    if ((level === 'friends' || level === 'extended') && req.user) {
      const friendLimit = level === 'friends' ? limit : Math.ceil(limit * 0.75);
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0
          AND (p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
          AND p.user_id NOT IN (SELECT blocked_user_id FROM user_relationship_blocks WHERE blocker_user_id = ?)
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(req.user.id, req.user.id, req.user.id, friendLimit, offset);

      if (level === 'extended') {
        const extLimit = limit - rows.length;
        if (extLimit > 0) {
          const extRows = db.prepare(`
            SELECT DISTINCT p.*, u.username, u.display_name, u.avatar_url
            FROM posts p JOIN users u ON p.user_id = u.id
            WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0 AND u.is_verified = 1
              AND p.user_id != ?
              AND p.user_id NOT IN (SELECT following_id FROM follows WHERE follower_id = ?)
              AND p.user_id NOT IN (SELECT blocked_user_id FROM user_relationship_blocks WHERE blocker_user_id = ?)
              AND p.user_id IN (
                SELECT following_id FROM follows WHERE follower_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
              )
            ORDER BY p.created_at DESC LIMIT ?
          `).all(req.user.id, req.user.id, req.user.id, req.user.id, extLimit);
          rows = [...rows, ...extRows].sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));
        }
      }
    } else if (level === 'everyone' && req.user) {
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0 AND u.is_verified = 1
          AND p.user_id NOT IN (SELECT blocked_user_id FROM user_relationship_blocks WHERE blocker_user_id = ?)
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(req.user.id, limit, offset);
    } else {
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0 AND u.is_verified = 1
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    }

    const posts = rows.map((r: any) => enrichPost(r, req.user?.id));
    res.json({ posts, worldItems: [], level });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
