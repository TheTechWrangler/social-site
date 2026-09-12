import { auditOperation } from '../operationalAudit.js';
import { serializeMedia } from '../mediaDto.js';
import { Router } from 'express';
import { createHash } from 'node:crypto';
import { removeRepostNotification } from '../notificationService.js';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { canViewGroup, canViewPost, userVisibilitySql, type Viewer } from '../visibility.js';
import { logUsage } from '../usageEvents.js';
import { validatePostContent, validatePostEdit, type PostEditInput } from '../postValidation.js';
import { positiveIntegerParam, validationErrorMessage } from '../requestValidation.js';

const router = Router();

const MAX_REPOST_DEPTH = 3;

// Ordinary editing never inherits a moderation role's permission to delete.
function postEditRestriction(viewer: Viewer | null | undefined, post: any) {
  if (!post || viewer?.id !== post.user_id || !canViewPost(viewer, post.id)) return 'not-found' as const;
  if (post.repost_of !== null) return 'ineligible' as const;
  if (getDb().prepare("SELECT 1 FROM reports WHERE post_id = ? AND status = 'open' LIMIT 1").get(post.id)) {
    return 'under-review' as const;
  }
  return null;
}

function visibleGroupOrigin(viewer: Viewer | null | undefined, groupId: number | null) {
  if (!groupId || !canViewGroup(viewer, groupId)) return null;
  const group = getDb().prepare('SELECT id, name FROM groups_table WHERE id = ?')
    .get(groupId) as { id: number; name: string } | undefined;
  return group ? { id: group.id, name: group.name } : null;
}

function enrichPost(row: any, viewer?: Viewer | null, depth = 0, visited = new Set<number>(), batch?: Map<number, any>): any {
  const cached = batch?.get(row.id);
  visited.add(row.id);
  const commentAuthor = userVisibilitySql(viewer, 'cu', 'public-context');
  const comments = cached ? { c: cached.commentCount } : getDb().prepare(`
    SELECT COUNT(*) as c
    FROM posts cp JOIN users cu ON cp.user_id = cu.id
    WHERE cp.parent_id = ? AND cp.hidden = 0 AND ${commentAuthor.sql}
  `).get(row.id, ...commentAuthor.params) as any;

  const repostAuthor = userVisibilitySql(viewer, 'ru', 'profile');
  const reposts = cached ? { c: cached.repostCount } : getDb().prepare(`
    SELECT COUNT(*) as c
    FROM posts rp JOIN users ru ON rp.user_id = ru.id
    WHERE rp.repost_of = ? AND rp.hidden = 0 AND ${repostAuthor.sql}
  `).get(row.id, ...repostAuthor.params) as any;

  // Get reaction counts grouped by type
  const reactionUser = userVisibilitySql(viewer, 'lu', 'identity');
  const reactionRows = cached ? cached.reactions : getDb().prepare(`
    SELECT l.reaction_type, COUNT(*) as c
    FROM likes l JOIN users lu ON l.user_id = lu.id
    WHERE l.post_id = ? AND ${reactionUser.sql}
    GROUP BY l.reaction_type
  `).all(row.id, ...reactionUser.params) as any[];
  const reactions: Record<string, number> = { like: 0, love: 0, laugh: 0, wow: 0, support: 0, thoughtful: 0 };
  for (const r of reactionRows) { reactions[r.reaction_type] = r.c; }

  // Get current user's reaction
  let userReaction: string | null = null;
  let liked = false;
  if (viewer?.id) {
    const ur = cached ? cached.userReaction : getDb().prepare('SELECT reaction_type FROM likes WHERE user_id = ? AND post_id = ?').get(viewer.id, row.id) as any;
    if (ur) { userReaction = ur.reaction_type; liked = true; }
  }

  let repostedPost = null;
  if (row.repost_of && depth < MAX_REPOST_DEPTH && !visited.has(row.repost_of)) {
    const rp = batch?.get(row.repost_of)?.row ?? getDb().prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar_url
      FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(row.repost_of) as any;
    if (rp && canViewPost(viewer, rp.id)) repostedPost = enrichPost(rp, viewer, depth + 1, visited, batch);
  }
  const group = visibleGroupOrigin(viewer, row.group_id ?? null);

  return {
    id: row.id,
    ...(cached ? { media: cached.media } : {}),
    content: row.content,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    parentId: row.parent_id ?? null,
    isRepost: row.repost_of !== null && row.repost_of !== undefined,
    repostOf: repostedPost ? row.repost_of : null,
    repostedPost,
    isGroupPost: row.group_id !== null && row.group_id !== undefined,
    groupId: group?.id ?? null,
    group,
    hidden: !!row.hidden,
    likeCount: reactions.like + reactions.love + reactions.laugh + reactions.wow + reactions.support + reactions.thoughtful,
    commentCount: comments?.c ?? 0,
    repostCount: reposts?.c ?? 0,
    reactions,
    userReaction,
    liked: liked,
    createdAt: row.created_at,
    editedAt: row.edited_at ?? null,
    editVersion: Number(row.edit_version ?? 0),
    canEdit: !!viewer &&
      (viewer.role === 'admin' || !!(viewer as Viewer & { is_verified?: number }).is_verified) &&
      postEditRestriction(viewer, row) === null,
  };
}

/** Batches counts, reactions, viewer state and media across a bounded page and
 * at most three nested repost levels. Authorization still uses the central policy.
 */
export function enrichPosts(rows: any[], viewer?: Viewer | null): any[] {
  if (!rows.length) return [];
  if (rows.length > 100) throw new Error('Post enrichment page exceeds 100 rows.');
  const db = getDb();
  const batch = new Map<number, any>();
  const add = (row: any) => batch.set(row.id, { row, commentCount: 0, repostCount: 0, reactions: [], userReaction: null, media: [] });
  rows.forEach(add);
  let frontier = rows;
  for (let depth = 0; depth < MAX_REPOST_DEPTH; depth++) {
    const ids = [...new Set(frontier.map(row => row.repost_of).filter(id => id && !batch.has(id)))];
    if (!ids.length) break;
    frontier = db.prepare(`SELECT p.*, u.username, u.display_name, u.avatar_url FROM posts p
      JOIN users u ON u.id = p.user_id WHERE p.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[];
    frontier.forEach(add);
  }
  const ids = [...batch.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const comments = userVisibilitySql(viewer, 'u', 'public-context');
  const reposts = userVisibilitySql(viewer, 'u', 'profile');
  const reactions = userVisibilitySql(viewer, 'u', 'identity');
  for (const row of db.prepare(`SELECT p.parent_id AS id, COUNT(*) AS count FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.parent_id IN (${placeholders}) AND p.hidden = 0 AND ${comments.sql} GROUP BY p.parent_id`).all(...ids, ...comments.params) as any[]) batch.get(row.id).commentCount = row.count;
  for (const row of db.prepare(`SELECT p.repost_of AS id, COUNT(*) AS count FROM posts p JOIN users u ON u.id = p.user_id
    WHERE p.repost_of IN (${placeholders}) AND p.hidden = 0 AND ${reposts.sql} GROUP BY p.repost_of`).all(...ids, ...reposts.params) as any[]) batch.get(row.id).repostCount = row.count;
  for (const row of db.prepare(`SELECT l.post_id, l.reaction_type, COUNT(*) AS c FROM likes l JOIN users u ON u.id = l.user_id
    WHERE l.post_id IN (${placeholders}) AND ${reactions.sql} GROUP BY l.post_id, l.reaction_type`).all(...ids, ...reactions.params) as any[]) batch.get(row.post_id).reactions.push(row);
  if (viewer?.id) for (const row of db.prepare(`SELECT post_id, reaction_type FROM likes WHERE user_id = ? AND post_id IN (${placeholders})`).all(viewer.id, ...ids) as any[]) batch.get(row.post_id).userReaction = row;
  for (const row of db.prepare(`SELECT * FROM post_media WHERE post_id IN (${placeholders}) ORDER BY post_id, sort_order, id`).all(...ids) as any[]) {
    const owner = batch.get(row.post_id).row.user_id;
    batch.get(row.post_id).media.push({ ...serializeMedia(row), canEditAlt: !!viewer && viewer.id === owner &&
      (viewer.role === 'admin' || !!(viewer as Viewer & { is_verified?: number }).is_verified) && row.media_type === 'image' });
  }
  return rows.map(row => enrichPost(row, viewer, 0, new Set(), batch));
}

const POST_SUBMISSION_KEY = /^[A-Za-z0-9_-]{16,100}$/;
const POST_SUBMISSION_TTL_MS = 24 * 60 * 60 * 1000;

// POST /api/posts — create a post
router.post('/', requireAuth, requireVerified, (req: AuthRequest, res) => {
  try {
    const { content, groupId, clientSubmissionKey } = req.body ?? {};
    const normalizedContent = validatePostContent(content);
    if (clientSubmissionKey !== undefined && !POST_SUBMISSION_KEY.test(String(clientSubmissionKey))) {
      res.status(400).json({ error: 'Invalid post submission key.' }); return;
    }

    if (groupId) {
      const groupOwnerVisibility = userVisibilitySql(req.user, 'u', 'public-context');
      const group = getDb().prepare(`
        SELECT g.id FROM groups_table g JOIN users u ON u.id = g.owner_id
        WHERE g.id = ? AND ${groupOwnerVisibility.sql}
      `).get(Number(groupId), ...groupOwnerVisibility.params);
      if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
      const isMember = getDb().prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(Number(groupId), req.user!.id);
      if (!isMember && req.user!.role !== 'admin') {
        res.status(403).json({ error: 'You must be a member of this group to post.' }); return;
      }
    }

    const normalizedGroupId = groupId ? Number(groupId) : null;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ content: normalizedContent, groupId: normalizedGroupId }))
      .digest('hex');
    const nowMs = Date.now();
    const create = getDb().transaction(() => {
      getDb().prepare(`
        DELETE FROM post_submission_keys
        WHERE rowid IN (
          SELECT rowid FROM post_submission_keys
          WHERE expires_at_ms <= ? ORDER BY expires_at_ms LIMIT 100
        )
      `).run(nowMs);

      if (clientSubmissionKey !== undefined) {
        getDb().prepare(`
          DELETE FROM post_submission_keys
          WHERE user_id = ? AND submission_key = ? AND expires_at_ms <= ?
        `).run(req.user!.id, String(clientSubmissionKey), nowMs);
        const existing = getDb().prepare(`
          SELECT post_id, request_hash
          FROM post_submission_keys
          WHERE user_id = ? AND submission_key = ? AND expires_at_ms > ?
        `).get(req.user!.id, String(clientSubmissionKey), nowMs) as any;
        if (existing) {
          if (existing.request_hash !== requestHash) {
            return { conflict: true, postId: 0, replayed: false };
          }
          return { conflict: false, postId: existing.post_id as number, replayed: true };
        }
      }

      const inserted = getDb().prepare(
        'INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)'
      ).run(req.user!.id, normalizedContent, normalizedGroupId);
      const postId = Number(inserted.lastInsertRowid);
      if (clientSubmissionKey !== undefined) {
        getDb().prepare(`
          INSERT INTO post_submission_keys
            (user_id, submission_key, post_id, request_hash, created_at_ms, expires_at_ms)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          req.user!.id,
          String(clientSubmissionKey),
          postId,
          requestHash,
          nowMs,
          nowMs + POST_SUBMISSION_TTL_MS,
        );
      }
      return { conflict: false, postId, replayed: false };
    });
    const result = create();
    if (result.conflict) {
      res.status(409).json({ error: 'Post submission key was already used for different content.' });
      return;
    }

    const row = getDb().prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar_url
      FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(result.postId);

    if (!result.replayed) {
      logUsage({ eventType: 'post_created', userId: req.user!.id, featureArea: groupId ? 'groups' : 'feed' });
    }
    res.status(result.replayed ? 200 : 201).json({
      post: enrichPost(row, req.user as any),
      replayed: result.replayed,
    });
  } catch (err: any) {
    const validationError = validationErrorMessage(err);
    if (validationError) { res.status(400).json({ error: validationError }); return; }
    console.error('[posts] Create post error:', err.message);
    res.status(500).json({ error: 'Could not create post.' });
  }
});

// PATCH /api/posts/:id — author-only text edit with optimistic concurrency.
router.patch('/:id', requireAuth, requireVerified, (req: AuthRequest, res) => {
  let postId: number;
  let input: PostEditInput;
  try {
    postId = positiveIntegerParam(req.params.id, 'post id');
    input = validatePostEdit(req.body);
  } catch (error) {
    const message = validationErrorMessage(error);
    res.status(message?.startsWith('post id') ? 404 : 400).json({ error: message || 'Invalid request.' });
    return;
  }

  const db = getDb();
  const editPost = db.transaction(() => {
    const post = db.prepare(`
      SELECT id, user_id, content, parent_id, repost_of, group_id, hidden,
        edited_at, edit_version
      FROM posts WHERE id = ?
    `).get(postId) as any;
    const restriction = postEditRestriction(req.user, post);
    if (restriction) return { kind: restriction };
    if (post.edit_version !== input.expectedEditVersion) return { kind: 'stale' as const };
    if (post.content === input.content) return { kind: 'unchanged' as const };

    const updated = db.prepare(`
      UPDATE posts
      SET content = ?, edited_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), edit_version = edit_version + 1
      WHERE id = ? AND user_id = ? AND hidden = 0 AND repost_of IS NULL AND edit_version = ?
    `).run(input.content, postId, req.user!.id, input.expectedEditVersion);
    if (updated.changes !== 1) return { kind: 'stale' as const };
    return { kind: 'updated' as const };
  });

  const result = editPost.immediate();
  if (result.kind === 'not-found') { res.status(404).json({ error: 'Post not found.' }); return; }
  if (result.kind === 'ineligible') { res.status(409).json({ error: 'Repost wrappers cannot be edited.' }); return; }
  if (result.kind === 'stale') {
    res.status(409).json({ error: 'This post changed elsewhere. Reload it before saving again.', code: 'STALE_POST_EDIT' });
    return;
  }
  if (result.kind === 'under-review') {
    res.status(409).json({ error: 'This post cannot be edited while it is under moderation review.', code: 'POST_UNDER_REVIEW' });
    return;
  }

  const row = db.prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(postId);
  if (!row) { res.status(404).json({ error: 'Post not found.' }); return; }
  res.json({ post: enrichPost(row, req.user as any), changed: result.kind === 'updated' });
});

// GET /api/posts/:id
router.get('/:id', optionalAuth, (req: AuthRequest, res) => {
  const postId = Number(req.params.id);
  if (!canViewPost(req.user as any, postId)) { res.status(404).json({ error: 'Post not found.' }); return; }
  const row = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(postId);
  if (!row) { res.status(404).json({ error: 'Post not found.' }); return; }
  res.json({ post: enrichPost(row, req.user as any) });
});

// DELETE /api/posts/:id
router.delete('/:id', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const post = getDb().prepare(`
    SELECT id, user_id, repost_of FROM posts
    WHERE id = ? AND (user_id = ? OR ? = 'admin')
  `).get(req.params.id, req.user!.id, req.user!.role) as any;
  if (!post) { res.status(404).json({ error: 'Not found.' }); return; }
  const deletePost = getDb().transaction(() => {
    if (post.repost_of !== null) removeRepostNotification(post.user_id, post.repost_of);
    const result = getDb().prepare('DELETE FROM posts WHERE id = ?').run(post.id);
    if (result.changes !== 1) throw new Error('Post deletion did not complete.');
    auditOperation(getDb(), 'post.deleted', req.user!.id, 'post', post.id);
  });
  deletePost();
  res.json({ ok: true });
});

export { enrichPost };
export default router;
