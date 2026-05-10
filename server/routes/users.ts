import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, type AuthRequest } from '../middleware.js';
import { getUserById } from '../auth.js';

const router = Router();

// GET /api/users/:username
router.get('/:username', optionalAuth, (req: AuthRequest, res) => {
  const row = getDb().prepare(`
    SELECT id, username, display_name, email, bio, avatar_url, role, created_at
    FROM users WHERE username = ?
  `).get(req.params.username) as any;
  if (!row) { res.status(404).json({ error: 'User not found.' }); return; }

  const followers = getDb().prepare('SELECT COUNT(*) as c FROM follows WHERE following_id = ?').get(row.id) as any;
  const following = getDb().prepare('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?').get(row.id) as any;
  const postCount = getDb().prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND parent_id IS NULL').get(row.id) as any;

  let isFollowing = false;
  if (req.user) {
    const f = getDb().prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, row.id);
    isFollowing = !!f;
  }

  res.json({
    user: {
      id: row.id, username: row.username, displayName: row.display_name,
      bio: row.bio, avatarUrl: row.avatar_url, role: row.role, createdAt: row.created_at,
      followerCount: followers?.c ?? 0, followingCount: following?.c ?? 0,
      postCount: postCount?.c ?? 0, isFollowing,
    }
  });
});

// PUT /api/users/profile
router.put('/profile', requireAuth, (req: AuthRequest, res) => {
  const { displayName, bio } = req.body;
  getDb().prepare('UPDATE users SET display_name = ?, bio = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(displayName || null, bio || null, req.user!.id);
  const user = getUserById(req.user!.id);
  res.json({ user });
});

// GET /api/users/search?q=...
router.get('/', (req, res) => {
  const q = `%${(req.query.q as string || '').trim()}%`;
  const rows = getDb().prepare(
    'SELECT id, username, display_name, avatar_url FROM users WHERE username LIKE ? OR display_name LIKE ? LIMIT 20'
  ).all(q, q);
  res.json({ users: rows });
});

export default router;
