import { getDb } from './database.js';

export interface Viewer {
  id: number;
  role: string;
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

export function canViewUserProfile(viewer: Viewer | null | undefined, targetUserId: number): boolean {
  const target = getDb().prepare('SELECT id, profile_visibility, banned FROM users WHERE id = ?').get(targetUserId) as any;
  if (!target || target.banned) return false;
  if (isAdmin(viewer)) return true;
  if (viewer?.id === targetUserId) return true;
  if (viewer?.id && isBlockedBetween(viewer.id, targetUserId)) return false;
  if (target.profile_visibility !== 'private') return true;
  if (!viewer?.id) return false;
  return !!getDb().prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(viewer.id, targetUserId);
}

export function canViewPost(viewer: Viewer | null | undefined, postId: number): boolean {
  const post = getDb().prepare(`
    SELECT p.id, p.user_id, p.hidden, u.banned
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(postId) as any;
  if (!post || post.banned) return false;
  if (isAdmin(viewer)) return true;
  if (post.hidden) return false;
  return canViewUserProfile(viewer, post.user_id);
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
    !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(a, b) &&
    !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?').get(b, a);

  const isFriend = isMutualFollow(senderId, recipientId);
  if (policy === 'friends') return isFriend;

  // friends_of_friends: direct mutual friend OR shared mutual friend
  if (isFriend) return true;
  return !!db.prepare(`
    SELECT 1 FROM follows f1
    WHERE f1.follower_id = ?
      AND EXISTS (SELECT 1 FROM follows WHERE follower_id = f1.following_id AND following_id = ?)
      AND EXISTS (SELECT 1 FROM follows WHERE follower_id = f1.following_id AND following_id = ?)
      AND EXISTS (SELECT 1 FROM follows WHERE follower_id = ? AND following_id = f1.following_id)
    LIMIT 1
  `).get(senderId, senderId, recipientId, recipientId);
}

export function canInteractWithPost(viewer: Viewer, postId: number): { ok: boolean; post?: any; error?: string; status?: number } {
  const post = getDb().prepare('SELECT id, user_id, parent_id, hidden FROM posts WHERE id = ?').get(postId) as any;
  if (!post) return { ok: false, status: 404, error: 'Post not found.' };
  if (!canViewPost(viewer, postId)) return { ok: false, status: 404, error: 'Post not found.' };
  if (!isAdmin(viewer) && isBlockedBetween(viewer.id, post.user_id)) {
    return { ok: false, status: 403, error: 'Not allowed to interact with this content.' };
  }
  return { ok: true, post };
}
