import { getDb } from './database.js';

export interface Viewer {
  id: number;
  role: string;
}

export interface VisibilityUser {
  id: number;
  profile_visibility: string;
  banned: number | boolean;
}

export type UserVisibility = 'hidden' | 'limited' | 'full';
export type VisibilityScope = 'identity' | 'profile' | 'public-context';

export interface SqlVisibilityPredicate {
  sql: string;
  params: Array<number | string>;
}

export function isAdmin(viewer?: Viewer | null): boolean {
  return viewer?.role === 'admin';
}

export function isBlockedBetween(userA: number, userB: number): boolean {
  if (!userA || !userB || userA === userB) return false;
  return !!getDb().prepare(`
    SELECT 1 FROM user_relationship_blocks
    WHERE relationship_type = 'block'
      AND ((blocker_user_id = ? AND blocked_user_id = ?) OR (blocker_user_id = ? AND blocked_user_id = ?))
  `).get(userA, userB, userB, userA);
}

export function hasMuted(viewerId: number, targetUserId: number): boolean {
  if (!viewerId || !targetUserId || viewerId === targetUserId) return false;
  return !!getDb().prepare(`
    SELECT 1 FROM user_relationship_blocks
    WHERE blocker_user_id = ? AND blocked_user_id = ? AND relationship_type = 'mute'
  `).get(viewerId, targetUserId);
}

export function isAcceptedFollower(viewerId: number, targetUserId: number): boolean {
  return !!getDb().prepare(
    "SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ? AND status = 'accepted'",
  ).get(viewerId, targetUserId);
}

/**
 * Resolve account visibility for an already-loaded user row.
 *
 * - hidden: banned, blocked in either direction, or anonymous -> private
 * - limited: signed-in non-follower -> private (identity card only)
 * - full: public, self, follower, or site admin
 *
 * Blocks and bans are evaluated before the admin privacy exception. Dedicated
 * moderation routes intentionally do not use this normal-user policy.
 */
export function getUserVisibility(
  viewer: Viewer | null | undefined,
  target: VisibilityUser,
): UserVisibility {
  if (!target || target.banned) return 'hidden';
  if (viewer?.id && viewer.id !== target.id && isBlockedBetween(viewer.id, target.id)) return 'hidden';
  if (viewer?.id === target.id || isAdmin(viewer)) return 'full';
  if (target.profile_visibility !== 'private') return 'full';
  if (!viewer?.id) return 'hidden';
  return isAcceptedFollower(viewer.id, target.id) ? 'full' : 'limited';
}

export function canViewUserIdentity(
  viewer: Viewer | null | undefined,
  target: VisibilityUser,
): boolean {
  return getUserVisibility(viewer, target) !== 'hidden';
}

export function canViewFullProfile(
  viewer: Viewer | null | undefined,
  target: VisibilityUser,
): boolean {
  return getUserVisibility(viewer, target) === 'full';
}

/**
 * An author may publish one specific item into an explicitly public context
 * (public group post, comment thread, LFG listing, or World Feed discussion).
 * Account privacy does not hide that item, but bans and two-way blocks do.
 */
export function canViewPublicContextAuthor(
  viewer: Viewer | null | undefined,
  target: VisibilityUser,
): boolean {
  if (!target || target.banned) return false;
  return !viewer?.id || viewer.id === target.id || !isBlockedBetween(viewer.id, target.id);
}

function safeAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error('Unsafe SQL alias in visibility policy.');
  }
  return alias;
}

/**
 * SQL equivalent of the centralized policy for list endpoints. Keeping the
 * block/follow checks in SQL avoids per-row visibility lookups.
 */
export function userVisibilitySql(
  viewer: Viewer | null | undefined,
  userAlias = 'u',
  scope: VisibilityScope = 'profile',
): SqlVisibilityPredicate {
  const u = safeAlias(userAlias);
  const clauses = [`${u}.banned = 0`];
  const params: Array<number | string> = [];

  if (viewer?.id) {
    clauses.push(`NOT EXISTS (
      SELECT 1 FROM user_relationship_blocks visibility_block
      WHERE visibility_block.relationship_type = 'block'
        AND (
          (visibility_block.blocker_user_id = ? AND visibility_block.blocked_user_id = ${u}.id)
          OR (visibility_block.blocker_user_id = ${u}.id AND visibility_block.blocked_user_id = ?)
        )
    )`);
    params.push(viewer.id, viewer.id);
  }

  if (scope === 'public-context') {
    return { sql: clauses.join(' AND '), params };
  }

  if (scope === 'identity') {
    if (!viewer?.id) clauses.push(`${u}.profile_visibility = 'public'`);
    return { sql: clauses.join(' AND '), params };
  }

  if (!viewer?.id) {
    clauses.push(`${u}.profile_visibility = 'public'`);
  } else if (!isAdmin(viewer)) {
    clauses.push(`(
      ${u}.id = ?
      OR ${u}.profile_visibility = 'public'
      OR EXISTS (
        SELECT 1 FROM follows visibility_follow
        WHERE visibility_follow.follower_id = ? AND visibility_follow.following_id = ${u}.id
          AND visibility_follow.status = 'accepted'
      )
    )`);
    params.push(viewer.id, viewer.id);
  }

  return { sql: clauses.join(' AND '), params };
}

export function notMutedByViewerSql(
  viewer: Viewer | null | undefined,
  userAlias = 'u',
): SqlVisibilityPredicate {
  const u = safeAlias(userAlias);
  if (!viewer?.id) return { sql: '1 = 1', params: [] };
  return {
    sql: `NOT EXISTS (
      SELECT 1 FROM user_relationship_blocks visibility_mute
      WHERE visibility_mute.relationship_type = 'mute'
        AND visibility_mute.blocker_user_id = ?
        AND visibility_mute.blocked_user_id = ${u}.id
    )`,
    params: [viewer.id],
  };
}

export function postAuthorVisibilitySql(
  viewer: Viewer | null | undefined,
  postAlias = 'p',
  userAlias = 'u',
): SqlVisibilityPredicate {
  const p = safeAlias(postAlias);
  const profile = userVisibilitySql(viewer, userAlias, 'profile');
  const publicContext = userVisibilitySql(viewer, userAlias, 'public-context');
  return {
    sql: `(
      (${p}.group_id IS NULL AND ${profile.sql})
      OR (${p}.group_id IS NOT NULL AND ${publicContext.sql})
    )`,
    params: [...profile.params, ...publicContext.params],
  };
}

export function canViewUserProfile(viewer: Viewer | null | undefined, targetUserId: number): boolean {
  const target = getDb().prepare(
    'SELECT id, profile_visibility, banned FROM users WHERE id = ?',
  ).get(targetUserId) as VisibilityUser | undefined;
  return !!target && canViewFullProfile(viewer, target);
}

/** Current groups are public; owner bans/blocks hide their discovery metadata. */
export function canViewGroup(viewer: Viewer | null | undefined, groupId: number): boolean {
  const owner = userVisibilitySql(viewer, 'u', 'public-context');
  return !!getDb().prepare(`SELECT 1 FROM groups_table g JOIN users u ON u.id = g.owner_id
    WHERE g.id = ? AND ${owner.sql}`).get(groupId, ...owner.params);
}

interface PostVisibilityRow extends VisibilityUser {
  post_id: number;
  parent_id: number | null;
  group_id: number | null;
  hidden: number;
}

export function canViewPost(
  viewer: Viewer | null | undefined,
  postId: number,
  visited = new Set<number>(),
): boolean {
  if (!Number.isSafeInteger(postId) || postId <= 0 || visited.has(postId) || visited.size >= 64) return false;
  visited.add(postId);

  const post = getDb().prepare(`
    SELECT p.id AS post_id, p.user_id AS id, p.parent_id, p.group_id, p.hidden,
      u.profile_visibility, u.banned
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(postId) as PostVisibilityRow | undefined;

  if (!post || post.hidden) return false;

  if (post.parent_id !== null) {
    return canViewPublicContextAuthor(viewer, post)
      && canViewPost(viewer, post.parent_id, visited);
  }

  if (post.group_id !== null) return canViewPublicContextAuthor(viewer, post);
  return canViewFullProfile(viewer, post);
}

// DM privacy values stored in users.dm_privacy
export type DmPrivacy = 'noone' | 'friends' | 'friends_of_friends' | 'everyone';

export function canUserMessageRecipient(senderId: number, recipientId: number): boolean {
  if (senderId === recipientId) return false;
  if (isBlockedBetween(senderId, recipientId)) return false;

  const db = getDb();
  const recipient = db.prepare('SELECT dm_privacy FROM users WHERE id = ? AND banned = 0').get(recipientId) as any;
  if (!recipient) return false;

  const policy: DmPrivacy = (recipient.dm_privacy as DmPrivacy) || 'friends_of_friends';
  if (policy === 'noone') return false;
  if (policy === 'everyone') return true;

  const isMutualFollow = (a: number, b: number) =>
    !!db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ? AND status = 'accepted'").get(a, b) &&
    !!db.prepare("SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ? AND status = 'accepted'").get(b, a);

  const isFriend = isMutualFollow(senderId, recipientId);
  if (policy === 'friends') return isFriend;

  // friends_of_friends: direct mutual friend OR shared mutual friend
  if (isFriend) return true;
  return !!db.prepare(`
    SELECT 1 FROM follows f1
    WHERE f1.follower_id = ?
      AND f1.status = 'accepted'
      AND EXISTS (SELECT 1 FROM follows WHERE follower_id = f1.following_id AND following_id = ? AND status = 'accepted')
      AND EXISTS (SELECT 1 FROM follows WHERE follower_id = f1.following_id AND following_id = ? AND status = 'accepted')
      AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND following_id = f1.following_id AND status = 'accepted')
    LIMIT 1
  `).get(senderId, senderId, recipientId, recipientId);
}

export function canInteractWithPost(viewer: Viewer, postId: number): { ok: boolean; post?: any; error?: string; status?: number } {
  const post = getDb().prepare('SELECT id, user_id, parent_id, hidden FROM posts WHERE id = ?').get(postId) as any;
  if (!post || !canViewPost(viewer, postId)) {
    return { ok: false, status: 404, error: 'Post not found.' };
  }
  if (!isAdmin(viewer) && isBlockedBetween(viewer.id, post.user_id)) {
    return { ok: false, status: 403, error: 'Not allowed to interact with this content.' };
  }
  return { ok: true, post };
}
