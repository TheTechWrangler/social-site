import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { canViewPost, userVisibilitySql, type Viewer } from '../visibility.js';
import { logUsage } from '../usageEvents.js';

const router = Router();

function enrichPost(row: any, viewer?: Viewer | null): any {
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
  if (row.repost_of) {
    const rp = getDb().prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar_url
      FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(row.repost_of) as any;
    if (rp && canViewPost(viewer, rp.id)) repostedPost = enrichPost(rp, viewer);
  }

  return {
    id: row.id,
    content: row.content,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    parentId: row.parent_id ?? null,
    repostOf: row.repost_of ?? null,
    repostedPost,
    groupId: row.group_id ?? null,
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

// POST /api/posts — create a post
router.post('/', requireAuth, requireVerified, (req: AuthRequest, res) => {
  try {
    const { content, groupId } = req.body;
    if (!content?.trim()) { res.status(400).json({ error: 'Content required.' }); return; }
    if (content.trim().length > POST_MAX_LENGTH) {
      res.status(400).json({ error: `Post content must be ${POST_MAX_LENGTH} characters or fewer.` }); return;
    }

    if (groupId) {
      const group = getDb().prepare('SELECT id FROM groups_table WHERE id = ?').get(Number(groupId));
      if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
      const isMember = getDb().prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(Number(groupId), req.user!.id);
      if (!isMember && req.user!.role !== 'admin') {
        res.status(403).json({ error: 'You must be a member of this group to post.' }); return;
      }
    }

    const result = getDb().prepare(
      'INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)'
    ).run(req.user!.id, content.trim(), groupId ? Number(groupId) : null);

    const row = getDb().prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar_url
      FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(result.lastInsertRowid);

    logUsage({ eventType: 'post_created', userId: req.user!.id, featureArea: groupId ? 'groups' : 'feed' });
    res.status(201).json({ post: enrichPost(row, req.user as any) });
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
  const post = getDb().prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id) as any;
  if (!post) { res.status(404).json({ error: 'Not found.' }); return; }
  if (post.user_id !== req.user!.id && req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Not authorized.' }); return;
  }
  getDb().prepare('DELETE FROM posts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export { enrichPost };
export default router;
