import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, type AuthRequest } from '../middleware.js';
import { getUserById } from '../auth.js';

const router = Router();

function connectionUserRows(userId: number, mode: 'following' | 'followers' | 'friends') {
  const relationWhere = mode === 'following'
    ? 'f.follower_id = ? AND u.id = f.following_id'
    : mode === 'followers'
      ? 'f.following_id = ? AND u.id = f.follower_id'
      : `f.follower_id = ? AND u.id = f.following_id
        AND EXISTS (SELECT 1 FROM follows mf WHERE mf.follower_id = u.id AND mf.following_id = ?)`;
  const params = mode === 'friends'
    ? [userId, userId, userId, userId, userId, userId, userId]
    : [userId, userId, userId, userId, userId, userId];
  return getDb().prepare(`
    SELECT
      u.id,
      u.username,
      u.display_name,
      u.avatar_url,
      CASE
        WHEN u.profile_visibility = 'public'
          OR EXISTS (SELECT 1 FROM follows vf WHERE vf.follower_id = ? AND vf.following_id = u.id)
        THEN substr(u.bio, 1, 160)
        ELSE ''
      END as bio_snippet,
      u.is_verified,
      u.profile_visibility,
      EXISTS (SELECT 1 FROM follows cf WHERE cf.follower_id = ? AND cf.following_id = u.id) as is_following,
      EXISTS (SELECT 1 FROM follows cm WHERE cm.follower_id = u.id AND cm.following_id = ?) as follows_me
    FROM follows f
    JOIN users u ON (${relationWhere})
    WHERE u.banned = 0
      AND NOT EXISTS (
        SELECT 1 FROM user_relationship_blocks b
        WHERE b.relationship_type = 'block'
          AND ((b.blocker_user_id = ? AND b.blocked_user_id = u.id) OR (b.blocker_user_id = u.id AND b.blocked_user_id = ?))
      )
    ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE
  `).all(...params);
}

function formatConnectionUser(row: any) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    displayName: row.display_name,
    avatar_url: row.avatar_url,
    avatarUrl: row.avatar_url,
    bio_snippet: row.bio_snippet || '',
    bioSnippet: row.bio_snippet || '',
    is_verified: row.is_verified,
    isVerified: !!row.is_verified,
    profile_visibility: row.profile_visibility,
    profileVisibility: row.profile_visibility,
    isFollowing: !!row.is_following,
    followsMe: !!row.follows_me,
  };
}

// ─── Block / Mute ───

router.get('/blocked/list', requireAuth, (req, res) => {
  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, r.created_at
    FROM user_relationship_blocks r JOIN users u ON r.blocked_user_id = u.id
    WHERE r.blocker_user_id = ? AND r.relationship_type = 'block' ORDER BY r.created_at DESC
  `).all((req as any).user.id);
  res.json({ blocked: rows });
});

router.get('/muted/list', requireAuth, (req, res) => {
  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, r.created_at
    FROM user_relationship_blocks r JOIN users u ON r.blocked_user_id = u.id
    WHERE r.blocker_user_id = ? AND r.relationship_type = 'mute' ORDER BY r.created_at DESC
  `).all((req as any).user.id);
  res.json({ muted: rows });
});

// ─── Current User Connections ───

router.get('/me/following', requireAuth, (req, res) => {
  const users = connectionUserRows((req as any).user.id, 'following').map(formatConnectionUser);
  res.json({ users });
});

router.get('/me/followers', requireAuth, (req, res) => {
  const users = connectionUserRows((req as any).user.id, 'followers').map(formatConnectionUser);
  res.json({ users });
});

router.get('/me/friends', requireAuth, (req, res) => {
  const users = connectionUserRows((req as any).user.id, 'friends').map(formatConnectionUser);
  res.json({ users });
});

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

  // Get visible game preferences
  const gamePrefs = getDb().prepare(`
    SELECT p.*, g.name as game_name, g.slug as game_slug
    FROM user_game_preferences p JOIN games g ON p.game_id = g.id
    WHERE p.user_id = ? AND p.display_on_profile = 1 ORDER BY p.is_favorite DESC, g.name
  `).all(row.id);

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
      gamePrefs,
    }
  });
});

// PUT /api/users/profile
router.put('/profile', requireAuth, (req: AuthRequest, res) => {
  const { displayName, bio, profileVisibility, feedExposure, worldHomeInjection, gameDiscoveryEnabled, avatar_url } = req.body;
  const vis = profileVisibility === 'private' ? 'private' : 'public';
  const fex = ['friends_only', 'mixed', 'everyone', 'friends', 'extended', 'world'].includes(feedExposure) ? feedExposure : 'extended';
  const whi = ['world_home_off', 'world_home_few', 'world_home_balanced'].includes(worldHomeInjection) ? worldHomeInjection : undefined;
  const fields: string[] = [];
  const vals: any[] = [];
  if (displayName !== undefined) { fields.push('display_name = ?'); vals.push(displayName); }
  if (bio !== undefined) { fields.push('bio = ?'); vals.push(bio); }
  if (avatar_url !== undefined) { fields.push('avatar_url = ?'); vals.push(avatar_url); }
  if (profileVisibility !== undefined) { fields.push('profile_visibility = ?'); vals.push(vis); }
  if (feedExposure !== undefined) { fields.push('feed_exposure = ?'); vals.push(fex); }
  if (whi !== undefined) { fields.push('world_home_injection = ?'); vals.push(whi); }
  if (gameDiscoveryEnabled !== undefined) { fields.push('game_discovery_enabled = ?'); vals.push(gameDiscoveryEnabled ? 1 : 0); }
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

router.post('/:userId/block', requireAuth, (req, res) => {
  const blockerId = (req as any).user.id;
  const blockedId = Number(req.params.userId);
  if (blockerId === blockedId) { res.status(400).json({ error: 'Cannot block yourself.' }); return; }
  const db = getDb();
  db.prepare("DELETE FROM user_relationship_blocks WHERE blocker_user_id = ? AND blocked_user_id = ? AND relationship_type = 'mute'").run(blockerId, blockedId);
  db.prepare('DELETE FROM follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)').run(blockerId, blockedId, blockedId, blockerId);
  db.prepare("INSERT OR IGNORE INTO user_relationship_blocks (blocker_user_id, blocked_user_id, relationship_type) VALUES (?, ?, 'block')").run(blockerId, blockedId);
  res.json({ ok: true, blocked: true });
});

router.delete('/:userId/block', requireAuth, (req, res) => {
  getDb().prepare("DELETE FROM user_relationship_blocks WHERE blocker_user_id = ? AND blocked_user_id = ? AND relationship_type = 'block'").run((req as any).user.id, req.params.userId);
  res.json({ ok: true, blocked: false });
});

router.post('/:userId/mute', requireAuth, (req, res) => {
  const blockerId = (req as any).user.id;
  const mutedId = Number(req.params.userId);
  if (blockerId === mutedId) { res.status(400).json({ error: 'Cannot mute yourself.' }); return; }
  getDb().prepare("INSERT OR IGNORE INTO user_relationship_blocks (blocker_user_id, blocked_user_id, relationship_type) VALUES (?, ?, 'mute')").run(blockerId, mutedId);
  res.json({ ok: true, muted: true });
});

router.delete('/:userId/mute', requireAuth, (req, res) => {
  getDb().prepare("DELETE FROM user_relationship_blocks WHERE blocker_user_id = ? AND blocked_user_id = ? AND relationship_type = 'mute'").run((req as any).user.id, req.params.userId);
  res.json({ ok: true, muted: false });
});

export default router;
