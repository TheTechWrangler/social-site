import { Router } from 'express';
import { createHash } from 'node:crypto';
import { removeRepostNotification } from '../notificationService.js';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { canViewGroup, canViewPost, userVisibilitySql, type Viewer } from '../visibility.js';
import { logUsage } from '../usageEvents.js';

const router = Router();

const MAX_REPOST_DEPTH = 3;

function enrichPost(row: any, viewer?: Viewer | null, depth = 0, visited = new Set<number>()): any {
  visited.add(row.id);
  const commentAuthor = userVisibilitySql(viewer, 'cu', 'public-context');
  const comments = getDb().prepare(`
    SELECT COUNT(*) as c
    FROM posts cp JOIN users cu ON cp.user_id = cu.id
    WHERE cp.parent_id = ? AND cp.hidden = 0 AND ${commentAuthor.sql}
  `).get(row.id, ...commentAuthor.params) as any;

  const repostAuthor = userVisibilitySql(viewer, 'ru', 'profile');
  const reposts = getDb().prepare(`
    SELECT COUNT(*) as c
    FROM posts rp JOIN users ru ON rp.user_id = ru.id
    WHERE rp.repost_of = ? AND rp.hidden = 0 AND ${repostAuthor.sql}
  `).get(row.id, ...repostAuthor.params) as any;

  // Get reaction counts grouped by type
  const reactionUser = userVisibilitySql(viewer, 'lu', 'identity');
  const reactionRows = getDb().prepare(`
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
    const ur = getDb().prepare('SELECT reaction_type FROM likes WHERE user_id = ? AND post_id = ?').get(viewer.id, row.id) as any;
    if (ur) { userReaction = ur.reaction_type; liked = true; }
  }

  let repostedPost = null;
  if (row.repost_of && depth < MAX_REPOST_DEPTH && !visited.has(row.repost_of)) {
    const rp = getDb().prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar_url
      FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(row.repost_of) as any;
    if (rp && canViewPost(viewer, rp.id)) repostedPost = enrichPost(rp, viewer, depth + 1, visited);
  }

  return {
    id: row.id,
    content: row.content,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    parentId: row.parent_id ?? null,
    repostOf: repostedPost ? row.repost_of : null,
    repostedPost,
    groupId: row.group_id && canViewGroup(viewer, row.group_id) ? row.group_id : null,
    hidden: !!row.hidden,
    likeCount: reactions.like + reactions.love + reactions.laugh + reactions.wow + reactions.support + reactions.thoughtful,
    commentCount: comments?.c ?? 0,
    repostCount: reposts?.c ?? 0,
    reactions,
    userReaction,
    liked: liked,
    createdAt: row.created_at,
  };
}

const POST_MAX_LENGTH = 5000;
const POST_SUBMISSION_KEY = /^[A-Za-z0-9_-]{16,100}$/;
const POST_SUBMISSION_TTL_MS = 24 * 60 * 60 * 1000;

// POST /api/posts — create a post
router.post('/', requireAuth, requireVerified, (req: AuthRequest, res) => {
  try {
    const { content, groupId, clientSubmissionKey } = req.body;
    if (!content?.trim()) { res.status(400).json({ error: 'Content required.' }); return; }
    if (content.trim().length > POST_MAX_LENGTH) {
      res.status(400).json({ error: `Post content must be ${POST_MAX_LENGTH} characters or fewer.` }); return;
    }
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

    const normalizedContent = content.trim();
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
    console.error('[posts] Create post error:', err.message);
    res.status(500).json({ error: 'Could not create post.' });
  }
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
  });
  deletePost();
  res.json({ ok: true });
});

export { enrichPost };
export default router;
