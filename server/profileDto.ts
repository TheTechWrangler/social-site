import { getDb } from './database.js';
import { getUserVisibility, userVisibilitySql, type Viewer } from './visibility.js';
import type { CanonicalProfileDto } from '../shared/profile.js';

export interface CanonicalProfileResponse {
  profile: CanonicalProfileDto;
  message?: string;
}

export function getCanonicalProfile(
  viewer: Viewer | null | undefined,
  lookup: { username: string } | { id: number },
): CanonicalProfileResponse | null {
  const db = getDb();
  const selector = 'username' in lookup ? 'username = ? COLLATE NOCASE' : 'id = ?';
  const value = 'username' in lookup ? lookup.username : lookup.id;
  const row = db.prepare(`
    SELECT id, username, display_name, bio, avatar_url, role, banned,
      is_verified, profile_visibility, created_at, profile_data
    FROM users WHERE ${selector}
  `).get(value) as any;
  if (!row) return null;

  const visibility = getUserVisibility(viewer, row);
  if (visibility === 'hidden') return null;

  const isOwner = viewer?.id === row.id;
  const relationship = !isOwner && viewer ? db.prepare(
    'SELECT status FROM follows WHERE follower_id = ? AND following_id = ?',
  ).get(viewer.id, row.id) as { status: 'pending' | 'accepted' } | undefined : undefined;
  const followStatus = relationship?.status ?? 'none';
  const isFollowing = followStatus === 'accepted';
  const isPrivate = row.profile_visibility === 'private';

  if (visibility === 'limited') {
    return {
      profile: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        isPrivate: true,
        isFollowing,
        ...(followStatus === 'pending' ? { followStatus } : {}),
        limited: true,
      },
      message: 'This profile is private.',
    };
  }

  const connectionVisibility = userVisibilitySql(viewer, 'u', 'identity');
  const followers = db.prepare(`
    SELECT COUNT(*) AS count FROM follows f
    JOIN users u ON u.id = f.follower_id
    WHERE f.following_id = ? AND f.status = 'accepted' AND ${connectionVisibility.sql}
  `).get(row.id, ...connectionVisibility.params) as { count: number };
  const following = db.prepare(`
    SELECT COUNT(*) AS count FROM follows f
    JOIN users u ON u.id = f.following_id
    WHERE f.follower_id = ? AND f.status = 'accepted' AND ${connectionVisibility.sql}
  `).get(row.id, ...connectionVisibility.params) as { count: number };
  const postCount = db.prepare(`
    SELECT COUNT(*) AS count FROM posts
    WHERE user_id = ? AND parent_id IS NULL AND group_id IS NULL AND hidden = 0
  `).get(row.id) as { count: number };

  const gameVisibilityClause = isOwner || viewer?.role === 'admin'
    ? ''
    : 'AND p.display_on_profile = 1';
  const gamePrefs = db.prepare(`
    SELECT p.*, g.name AS game_name, g.slug AS game_slug,
      EXISTS (
        SELECT 1 FROM user_game_preferences mine
        WHERE mine.user_id = ? AND mine.game_id = p.game_id
      ) AS shared_game
    FROM user_game_preferences p
    JOIN games g ON p.game_id = g.id
    WHERE p.user_id = ? ${gameVisibilityClause}
    ORDER BY p.is_favorite DESC, g.name
  `).all(viewer?.id || 0, row.id);

  let profileData: Record<string, string> | null = null;
  try {
    profileData = row.profile_data ? JSON.parse(row.profile_data) : null;
  } catch {
    profileData = null;
  }

  return {
    profile: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      bio: row.bio || '',
      avatarUrl: row.avatar_url || '',
      role: row.role,
      isVerified: !!row.is_verified,
      profileVisibility: isPrivate ? 'private' : 'public',
      isPrivate,
      followerCount: followers?.count ?? 0,
      followingCount: following?.count ?? 0,
      postCount: postCount?.count ?? 0,
      isFollowing,
      gamePrefs,
      profileData,
    },
  };
}
