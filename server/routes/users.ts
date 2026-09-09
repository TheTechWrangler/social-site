import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, type AuthRequest } from '../middleware.js';
import { getUserById } from '../auth.js';
import {
  getUserVisibility,
  userVisibilitySql,
  type Viewer,
} from '../visibility.js';
import { enrichPost } from './posts.js';
import { getCanonicalProfile } from '../profileDto.js';

const router = Router();

function connectionUserRows(viewer: Viewer, mode: 'following' | 'followers' | 'friends') {
  const userId = viewer.id;
  const relationWhere = mode === 'following'
    ? 'f.follower_id = ? AND u.id = f.following_id'
    : mode === 'followers'
      ? 'f.following_id = ? AND u.id = f.follower_id'
      : `f.follower_id = ? AND u.id = f.following_id
        AND EXISTS (SELECT 1 FROM follows mf WHERE mf.follower_id = u.id AND mf.following_id = ?)`;
  const relationParams = mode === 'friends' ? [userId, userId] : [userId];
  const identity = userVisibilitySql(viewer, 'u', 'identity');
  const fullProfile = userVisibilitySql(viewer, 'u', 'profile');
  return getDb().prepare(`
    SELECT
      u.id,
      u.username,
      u.display_name,
      u.avatar_url,
      CASE WHEN (${fullProfile.sql}) THEN substr(u.bio, 1, 160) ELSE '' END as bio_snippet,
      CASE WHEN (${fullProfile.sql}) THEN 1 ELSE 0 END as can_view_full,
      u.is_verified,
      u.profile_visibility,
      EXISTS (SELECT 1 FROM follows cf WHERE cf.follower_id = ? AND cf.following_id = u.id) as is_following,
      EXISTS (SELECT 1 FROM follows cm WHERE cm.follower_id = u.id AND cm.following_id = ?) as follows_me
    FROM follows f
    JOIN users u ON (${relationWhere})
    WHERE ${identity.sql}
    ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE
  `).all(
    ...fullProfile.params,
    ...fullProfile.params,
    userId,
    userId,
    ...relationParams,
    ...identity.params,
  );
}

function formatConnectionUser(row: any) {
  if (!row.can_view_full) {
    return {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      displayName: row.display_name,
      avatar_url: row.avatar_url,
      avatarUrl: row.avatar_url,
      isFollowing: !!row.is_following,
      followsMe: !!row.follows_me,
      isPrivate: true,
      limited: true,
    };
  }
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
  // Explicit unblock UI exception to blocks; bans still suppress identities.
  const identity = userVisibilitySql(null, 'u', 'public-context');
  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, r.created_at
    FROM user_relationship_blocks r JOIN users u ON r.blocked_user_id = u.id
    WHERE r.blocker_user_id = ? AND r.relationship_type = 'block' AND ${identity.sql} ORDER BY r.created_at DESC
  `).all((req as any).user.id);
  res.json({ blocked: rows });
});

router.get('/muted/list', requireAuth, (req, res) => {
  const identity = userVisibilitySql((req as any).user, 'u', 'identity');
  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, r.created_at
    FROM user_relationship_blocks r JOIN users u ON r.blocked_user_id = u.id
    WHERE r.blocker_user_id = ? AND r.relationship_type = 'mute' AND ${identity.sql} ORDER BY r.created_at DESC
  `).all((req as any).user.id, ...identity.params);
  res.json({ muted: rows });
});

// ─── Current User Connections ───

router.get('/me/following', requireAuth, (req, res) => {
  const users = connectionUserRows((req as any).user, 'following').map(formatConnectionUser);
  res.json({ users });
});

router.get('/me/followers', requireAuth, (req, res) => {
  const users = connectionUserRows((req as any).user, 'followers').map(formatConnectionUser);
  res.json({ users });
});

router.get('/me/friends', requireAuth, (req, res) => {
  const users = connectionUserRows((req as any).user, 'friends').map(formatConnectionUser);
  res.json({ users });
});

// GET /api/users/me/games
router.get('/me/games', requireAuth, (req: AuthRequest, res) => {
  const gamePrefs = getDb().prepare(`
    SELECT p.*, g.name as game_name, g.slug as game_slug, g.platforms as game_platforms
    FROM user_game_preferences p JOIN games g ON p.game_id = g.id
    WHERE p.user_id = ? ORDER BY p.is_favorite DESC, g.name
  `).all(req.user!.id);
  res.json({ gamePrefs });
});

// GET /api/users/:username/posts — profile-scoped posts only
router.get('/:username/posts', optionalAuth, (req: AuthRequest, res) => {
  const target = getDb().prepare(`
    SELECT id, profile_visibility, banned FROM users WHERE username = ? COLLATE NOCASE
  `).get(req.params.username) as any;
  if (!target || getUserVisibility(req.user as any, target) !== 'full') {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  const rows = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.user_id = ? AND p.parent_id IS NULL AND p.group_id IS NULL AND p.hidden = 0
    ORDER BY p.created_at DESC LIMIT 100
  `).all(target.id);
  res.json({ posts: rows.map((row: any) => enrichPost(row, req.user as any)) });
});

// GET /api/users/:username
router.get('/:username', optionalAuth, (req: AuthRequest, res) => {
  const result = getCanonicalProfile(req.user, { username: req.params.username });
  if (!result) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }
  res.json({ user: result.profile, ...(result.message ? { message: result.message } : {}) });
});

// PUT /api/users/profile
router.put('/profile', requireAuth, (req: AuthRequest, res) => {
  const { displayName, bio, profileVisibility, feedExposure, worldHomeInjection, gameDiscoveryEnabled, avatar_url, dmPrivacy, profileData } = req.body;
  if (displayName !== undefined && !String(displayName ?? '').trim()) {
    res.status(400).json({ error: 'Display name cannot be empty.' });
    return;
  }
  if (profileVisibility !== undefined && !['public', 'private'].includes(profileVisibility)) {
    res.status(400).json({ error: 'Invalid profile visibility.' });
    return;
  }
  if (
    profileData !== undefined &&
    profileData !== null &&
    (typeof profileData !== 'object' || Array.isArray(profileData))
  ) {
    res.status(400).json({ error: 'Invalid profile data.' });
    return;
  }
  const vis = profileVisibility as 'public' | 'private' | undefined;
  const fex = ['friends_only', 'mixed', 'everyone', 'friends', 'extended', 'world'].includes(feedExposure) ? feedExposure : 'extended';
  const whi = ['world_home_off', 'world_home_few', 'world_home_balanced'].includes(worldHomeInjection) ? worldHomeInjection : undefined;
  const dmp = ['noone', 'friends', 'friends_of_friends', 'everyone'].includes(dmPrivacy) ? dmPrivacy : undefined;
  const fields: string[] = [];
  const vals: any[] = [];
  if (displayName !== undefined) { fields.push('display_name = ?'); vals.push(String(displayName).trim().slice(0, 80)); }
  if (bio !== undefined) { fields.push('bio = ?'); vals.push(bio == null ? '' : String(bio).trim().slice(0, 500)); }
  if (avatar_url !== undefined) {
    // Local avatars must be created and assigned by the dedicated upload route.
    // This endpoint only supports clearing the current avatar; provider avatars
    // are assigned server-side during OAuth account creation.
    if (avatar_url !== '') {
      res.status(400).json({ error: 'Upload a new avatar using the avatar upload endpoint.' });
      return;
    }
    fields.push("avatar_url = ''");
  }
  if (profileVisibility !== undefined) { fields.push('profile_visibility = ?'); vals.push(vis); }
  if (feedExposure !== undefined) { fields.push('feed_exposure = ?'); vals.push(fex); }
  if (whi !== undefined) { fields.push('world_home_injection = ?'); vals.push(whi); }
  if (gameDiscoveryEnabled !== undefined) { fields.push('game_discovery_enabled = ?'); vals.push(gameDiscoveryEnabled ? 1 : 0); }
  if (dmp !== undefined) { fields.push('dm_privacy = ?'); vals.push(dmp); }
  // profileData: structured profile sections stored as JSON blob
  if (profileData !== undefined) {
    const PD_LIMITS: Record<string, number> = {
      techInterests: 200, platforms: 100, lookingFor: 200,
      currentProjects: 300, favoriteGenres: 150, websiteUrl: 200,
    };
    const pd: Record<string, string> = {};
    for (const [key, max] of Object.entries(PD_LIMITS)) {
      if (profileData && typeof profileData[key] === 'string') {
        const value = profileData[key].trim().slice(0, max);
        if (value) pd[key] = value;
      }
    }
    // websiteUrl must be http(s):// if provided
    if (pd.websiteUrl && !/^https?:\/\/.+/.test(pd.websiteUrl)) { delete pd.websiteUrl; }
    fields.push('profile_data = ?');
    vals.push(JSON.stringify(pd));
  }
  fields.push("updated_at = datetime('now')");
  vals.push(req.user!.id);
  getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  const result = getCanonicalProfile(req.user, { id: req.user!.id });
  const authUser = getUserById(req.user!.id);
  if (!result || !authUser) {
    res.status(500).json({ error: 'Could not load saved profile.' });
    return;
  }
  res.json({ user: result.profile, authUser });
});

// GET /api/users/search?q=...
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  const q = `%${(req.query.q as string || '').trim()}%`;
  const viewer = req.user as any;
  const identity = userVisibilitySql(viewer, 'u', 'identity');
  const fullProfile = userVisibilitySql(viewer, 'u', 'profile');
  const rows = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified,
      u.profile_visibility,
      CASE WHEN (${fullProfile.sql}) THEN u.bio ELSE '' END AS bio,
      CASE WHEN (${fullProfile.sql}) THEN 1 ELSE 0 END AS can_view_full,
      EXISTS (
        SELECT 1 FROM follows sf WHERE sf.follower_id = ? AND sf.following_id = u.id
      ) AS is_following
    FROM users u
    WHERE (u.username LIKE ? OR u.display_name LIKE ?)
      AND ${identity.sql}
    ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE
    LIMIT 20
  `).all(
    ...fullProfile.params,
    ...fullProfile.params,
    req.user?.id || 0,
    q,
    q,
    ...identity.params,
  ) as any[];
  res.json({
    users: rows.map(row => row.can_view_full ? {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      is_verified: row.is_verified,
      profile_visibility: row.profile_visibility,
      bio: row.bio,
      isFollowing: !!row.is_following,
    } : {
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      isFollowing: !!row.is_following,
      isPrivate: true,
      limited: true,
    }),
  });
});

router.post('/:userId/block', requireAuth, (req, res) => {
  const blockerId = (req as any).user.id;
  const blockedId = Number(req.params.userId);
  if (blockerId === blockedId) { res.status(400).json({ error: 'Cannot block yourself.' }); return; }
  const db = getDb();
  db.prepare("DELETE FROM user_relationship_blocks WHERE blocker_user_id = ? AND blocked_user_id = ? AND relationship_type = 'mute'").run(blockerId, blockedId);
  db.prepare('DELETE FROM follows WHERE (follower_id = ? AND following_id = ?) OR (follower_id = ? AND following_id = ?)').run(blockerId, blockedId, blockedId, blockerId);
  db.prepare(`INSERT OR IGNORE INTO user_relationship_blocks (blocker_user_id, blocked_user_id, relationship_type)
    SELECT ?, id, 'block' FROM users WHERE id = ?`).run(blockerId, blockedId);
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
  getDb().prepare(`INSERT OR IGNORE INTO user_relationship_blocks (blocker_user_id, blocked_user_id, relationship_type)
    SELECT ?, id, 'mute' FROM users WHERE id = ?`).run(blockerId, mutedId);
  res.json({ ok: true, muted: true });
});

router.delete('/:userId/mute', requireAuth, (req, res) => {
  getDb().prepare("DELETE FROM user_relationship_blocks WHERE blocker_user_id = ? AND blocked_user_id = ? AND relationship_type = 'mute'").run((req as any).user.id, req.params.userId);
  res.json({ ok: true, muted: false });
});

export default router;
