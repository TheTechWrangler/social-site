import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';

const router = Router();

function enrichPost(row: any, userId?: number): any {
  const comments = getDb().prepare('SELECT COUNT(*) as c FROM posts WHERE parent_id = ?').get(row.id) as any;
  const reposts = getDb().prepare('SELECT COUNT(*) as c FROM posts WHERE repost_of = ?').get(row.id) as any;

  // Get reaction counts grouped by type
  const reactionRows = getDb().prepare(
    'SELECT reaction_type, COUNT(*) as c FROM likes WHERE post_id = ? GROUP BY reaction_type'
  ).all(row.id) as any[];
  const reactions: Record<string, number> = { like: 0, love: 0, laugh: 0, wow: 0, support: 0, thoughtful: 0 };
  for (const r of reactionRows) { reactions[r.reaction_type] = r.c; }

  // Get current user's reaction
  let userReaction: string | null = null;
  let liked = false;
  if (userId) {
    const ur = getDb().prepare('SELECT reaction_type FROM likes WHERE user_id = ? AND post_id = ?').get(userId, row.id) as any;
    if (ur) { userReaction = ur.reaction_type; liked = true; }
  }

  let repostedPost = null;
  if (row.repost_of) {
    const rp = getDb().prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar_url
      FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(row.repost_of) as any;
    if (rp) repostedPost = enrichPost(rp, userId);
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

// POST /api/posts — create a post
router.post('/', requireAuth, requireVerified, (req: AuthRequest, res) => {
  try {
    const { content, groupId } = req.body;
    if (!content?.trim()) { res.status(400).json({ error: 'Content required.' }); return; }

    const result = getDb().prepare(
      'INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)'
    ).run(req.user!.id, content.trim(), groupId || null);

    const row = getDb().prepare(`
      SELECT p.*, u.username, u.display_name, u.avatar_url
      FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
    `).get(result.lastInsertRowid);

    res.status(201).json({ post: enrichPost(row, req.user!.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/posts/:id
router.get('/:id', optionalAuth, (req: AuthRequest, res) => {
  const row = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id WHERE p.id = ?
  `).get(req.params.id);
  if (!row) { res.status(404).json({ error: 'Post not found.' }); return; }
  res.json({ post: enrichPost(row, req.user?.id) });
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
