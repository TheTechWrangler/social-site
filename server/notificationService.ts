import { getDb } from './database.js';
import { canViewGroup, canViewPost, userVisibilitySql, type Viewer } from './visibility.js';

export type NotificationType = 'follow' | 'like' | 'comment' | 'repost' | 'group_invite';

/**
 * Notification policy matrix:
 * - follow: target <- follower; one row per active relationship; unfollow removes it.
 * - like: post author <- reactor; one row per active user/post reaction; a reaction
 *   change preserves it and removal deletes it.
 * - comment: direct parent author <- commenter; one row per comment source; source
 *   deletion cascades it, so separate comments remain separate events.
 * - repost: original author <- reposter; one row per active user/original pair;
 *   repost deletion removes it and original deletion cascades it.
 * - group_invite: legacy display-only data; there is no current invitation mutation.
 *   Existing rows are unique per recipient/actor/group and group deletion cascades them.
 *
 * All generated types suppress self-notifications. Action routes enforce current
 * interaction policy before calling these helpers; serialization rechecks actor and
 * source visibility so later blocks, bans, or source hiding cannot disclose context.
 */
export interface NotificationDto {
  id: number;
  type: NotificationType;
  read: 0 | 1;
  actor_username: string;
  post_id: number | null;
  group_id: number | null;
  post_snippet: string | null;
  comment_kind: 'comment' | 'reply' | null;
  created_at: string;
}

interface NotificationRow {
  id: number;
  user_id: number;
  actor_id: number;
  type: NotificationType;
  post_id: number | null;
  group_id: number | null;
  read: number;
  created_at: string;
  actor_username: string;
  source_user_id: number | null;
  source_parent_id: number | null;
  source_content: string | null;
  parent_parent_id: number | null;
}

export function createFollowNotification(recipientId: number, actorId: number): void {
  if (recipientId === actorId) return;
  getDb().prepare(`
    INSERT OR IGNORE INTO notifications (user_id, actor_id, type)
    VALUES (?, ?, 'follow')
  `).run(recipientId, actorId);
}

export function createReactionNotification(recipientId: number, actorId: number, postId: number): void {
  if (recipientId === actorId) return;
  getDb().prepare(`
    INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id)
    VALUES (?, ?, 'like', ?)
  `).run(recipientId, actorId, postId);
}

export function createCommentNotification(recipientId: number, actorId: number, commentId: number): void {
  if (recipientId === actorId) return;
  getDb().prepare(`
    INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id)
    VALUES (?, ?, 'comment', ?)
  `).run(recipientId, actorId, commentId);
}

export function createRepostNotification(recipientId: number, actorId: number, postId: number): void {
  if (recipientId === actorId) return;
  getDb().prepare(`
    INSERT OR IGNORE INTO notifications (user_id, actor_id, type, post_id)
    VALUES (?, ?, 'repost', ?)
  `).run(recipientId, actorId, postId);
}

export function removeFollowNotification(recipientId: number, actorId: number): void {
  getDb().prepare(`
    DELETE FROM notifications WHERE type = 'follow' AND user_id = ? AND actor_id = ?
  `).run(recipientId, actorId);
}

export function removeReactionNotification(actorId: number, postId: number): void {
  getDb().prepare(`DELETE FROM notifications WHERE type = 'like' AND actor_id = ? AND post_id = ?`)
    .run(actorId, postId);
}

export function removeRepostNotification(actorId: number, postId: number): void {
  getDb().prepare(`DELETE FROM notifications WHERE type = 'repost' AND actor_id = ? AND post_id = ?`)
    .run(actorId, postId);
}

export function removeNotificationsBetweenUsers(userA: number, userB: number): void {
  getDb().prepare(`
    DELETE FROM notifications
    WHERE (user_id = ? AND actor_id = ?) OR (user_id = ? AND actor_id = ?)
  `).run(userA, userB, userB, userA);
}

function loadCandidateRows(
  viewer: Viewer,
  options: { notificationId?: number; unreadOnly?: boolean } = {},
): NotificationRow[] {
  const actorVisibility = userVisibilitySql(viewer, 'actor', 'identity');
  const conditions = ['n.user_id = ?', actorVisibility.sql];
  const values: Array<number | string> = [viewer.id, ...actorVisibility.params];
  if (options.notificationId !== undefined) {
    conditions.push('n.id = ?');
    values.push(options.notificationId);
  }
  if (options.unreadOnly) conditions.push('n.read = 0');

  return getDb().prepare(`
    SELECT n.*,
      actor.username AS actor_username,
      source.user_id AS source_user_id,
      source.parent_id AS source_parent_id,
      source.content AS source_content,
      parent.parent_id AS parent_parent_id
    FROM notifications n
    JOIN users actor ON actor.id = n.actor_id
    LEFT JOIN posts source ON source.id = n.post_id
    LEFT JOIN posts parent ON parent.id = source.parent_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY n.created_at DESC, n.id DESC
  `).all(...values) as NotificationRow[];
}

function activeActionExists(row: NotificationRow): boolean {
  const db = getDb();
  switch (row.type) {
    case 'follow':
      return !!db.prepare(`
        SELECT 1 FROM follows
        WHERE follower_id = ? AND following_id = ? AND status = 'accepted'
      `)
        .get(row.actor_id, row.user_id);
    case 'like':
      return row.post_id !== null && row.source_user_id === row.user_id &&
        !!db.prepare(`SELECT 1 FROM likes WHERE user_id = ? AND post_id = ?`)
          .get(row.actor_id, row.post_id);
    case 'comment':
      return row.post_id !== null && row.source_user_id !== null;
    case 'repost':
      return row.post_id !== null && row.source_user_id === row.user_id &&
        !!db.prepare(`SELECT 1 FROM posts WHERE user_id = ? AND repost_of = ?`)
          .get(row.actor_id, row.post_id);
    case 'group_invite':
      return row.group_id !== null && !!db.prepare('SELECT 1 FROM groups_table WHERE id = ?').get(row.group_id);
  }
}

function isVisible(row: NotificationRow, viewer: Viewer): boolean {
  if (!activeActionExists(row)) return false;
  // Legacy group invitations remain as neutral history when their current
  // group context is inaccessible. Deleted groups still cascade the row.
  if (row.type === 'group_invite') return true;
  if (row.type === 'like' || row.type === 'comment' || row.type === 'repost') {
    return canViewPost(viewer, row.post_id!);
  }
  return true;
}

function toDto(row: NotificationRow, viewer: Viewer): NotificationDto {
  const isComment = row.type === 'comment';
  return {
    id: row.id,
    type: row.type,
    read: row.read === 1 ? 1 : 0,
    actor_username: row.actor_username,
    post_id: isComment ? row.source_parent_id : row.post_id,
    group_id: row.type === 'group_invite' && row.group_id !== null && canViewGroup(viewer, row.group_id)
      ? row.group_id
      : null,
    post_snippet: row.source_content ? row.source_content.slice(0, 120) : null,
    comment_kind: isComment ? (row.parent_parent_id === null ? 'comment' : 'reply') : null,
    created_at: row.created_at,
  };
}

export function listNotifications(viewer: Viewer, limit = 50): NotificationDto[] {
  return loadCandidateRows(viewer)
    .filter(row => isVisible(row, viewer))
    .slice(0, limit)
    .map(row => toDto(row, viewer));
}

export function unreadNotificationCount(viewer: Viewer): number {
  return loadCandidateRows(viewer, { unreadOnly: true }).filter(row => isVisible(row, viewer)).length;
}

export function markNotificationRead(viewer: Viewer, notificationId: number): { found: boolean; changed: boolean } {
  const row = loadCandidateRows(viewer, { notificationId })[0];
  if (!row || !isVisible(row, viewer)) return { found: false, changed: false };
  const result = getDb().prepare(`
    UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ? AND read = 0
  `).run(notificationId, viewer.id);
  return { found: true, changed: result.changes === 1 };
}

export function markAllNotificationsRead(viewer: Viewer): number {
  const ids = loadCandidateRows(viewer, { unreadOnly: true })
    .filter(row => isVisible(row, viewer))
    .map(row => row.id);
  if (ids.length === 0) return 0;
  const db = getDb();
  const markAll = db.transaction(() => {
    const mark = db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ? AND read = 0');
    let changed = 0;
    for (const id of ids) changed += mark.run(id, viewer.id).changes;
    return changed;
  });
  return markAll();
}
