import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, type AuthRequest } from '../middleware.js';
import { getUserById } from '../auth.js';

const router = Router();

// GET /api/users/:username
router.get('/:username', optionalAuth, (req: AuthRequest, res) => {
  const row = getDb().prepare(`
    SELECT id, username, display_name, email, bio, avatar_url, role, is_verified, profile_visibility, created_at
    FROM users WHERE username = ?
  `).get(req.params.username) as any;
  if (!row) { res.status(404).json({ error: 'User not found.' }); return; }

  const isOwner = req.user?.id === row.id;
  const isAdmin = req.user?.role === 'admin';
  const isFollowing = isOwner ? false : req.user ? !!(getDb().prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(req.user.id, row.id)) : false;
  const isPrivate = row.profile_visibility === 'private';
  const canViewFull = isOwner || isAdmin || isFollowing || !isPrivate;

  const followers = getDb().prepare('SELECT COUNT(*) as c FROM follows WHERE following_id = ?').get(row.id) as any;
  const following = getDb().prepare('SELECT COUNT(*) as c FROM follows WHERE follower_id = ?').get(row.id) as any;
  const postCount = getDb().prepare('SELECT COUNT(*) as c FROM posts WHERE user_id = ? AND parent_id IS NULL').get(row.id) as any;

  if (!canViewFull) {
    // Limited profile view for private profiles
    return res.json({
      user: {
        id: row.id, username: row.username, displayName: row.display_name,
        bio: '', avatarUrl: row.avatar_url, role: row.role, isVerified: !!row.is_verified,
        profileVisibility: row.profile_visibility, isPrivate: true,
        followerCount: followers?.c ?? 0, followingCount: following?.c ?? 0,
        postCount: 0, isFollowing, limited: true,
      },
      message: 'This profile is private.'
    });
  }

  res.json({
    user: {
      id: row.id, username: row.username, displayName: row.display_name,
      bio: row.bio, avatarUrl: row.avatar_url, role: row.role, isVerified: !!row.is_verified,
      profileVisibility: row.profile_visibility, isPrivate: isPrivate,
      followerCount: followers?.c ?? 0, followingCount: following?.c ?? 0,
      postCount: postCount?.c ?? 0, isFollowing,
    }
  });
});

// PUT /api/users/profile
router.put('/profile', requireAuth, (req: AuthRequest, res) => {
  const { displayName, bio, profileVisibility, feedExposure, avatar_url } = req.body;
  const vis = profileVisibility === 'private' ? 'private' : 'public';
  const fex = ['friends_only', 'mixed', 'everyone'].includes(feedExposure) ? feedExposure : 'mixed';
  const fields: string[] = [];
  const vals: any[] = [];
  if (displayName !== undefined) { fields.push('display_name = ?'); vals.push(displayName); }
  if (bio !== undefined) { fields.push('bio = ?'); vals.push(bio); }
  if (avatar_url !== undefined) { fields.push('avatar_url = ?'); vals.push(avatar_url); }
  fields.push('profile_visibility = ?'); vals.push(vis);
  fields.push('feed_exposure = ?'); vals.push(fex);
  fields.push("updated_at = datetime('now')");
  vals.push(req.user!.id);
  getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  const user = getUserById(req.user!.id);
  res.json({ user });
});

// GET /api/users/search?q=...
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  const q = `%${(req.query.q as string || '').trim()}%`;
  const isAuth = !!req.user;
  // For unauthenticated: only public profiles. For authenticated: all profiles.
  const rows = isAuth
    ? getDb().prepare('SELECT id, username, display_name, avatar_url, is_verified, profile_visibility, bio FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND banned = 0 LIMIT 20').all(q, q)
    : getDb().prepare("SELECT id, username, display_name, avatar_url, is_verified, profile_visibility, bio FROM users WHERE (username LIKE ? OR display_name LIKE ?) AND banned = 0 AND profile_visibility = 'public' LIMIT 20").all(q, q);
  res.json({ users: rows });
});

export default router;
