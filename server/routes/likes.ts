import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { canInteractWithPost, canViewPost } from '../visibility.js';

const router = Router();

const REACTIONS = ['like', 'love', 'laugh', 'wow', 'support', 'thoughtful'];
const REACTION_EMOJI: Record<string, string> = {
  like: '👍', love: '❤️', laugh: '😂', wow: '😮', support: '🙌', thoughtful: '🤔',
};

// POST /api/likes/:postId — set/change reaction
router.post('/:postId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const postId = Number(req.params.postId);
  const reactionType = (req.body.reactionType as string) || 'like';
  if (!REACTIONS.includes(reactionType)) {
    res.status(400).json({ error: `Reaction must be one of: ${REACTIONS.join(', ')}` }); return;
  }

  const access = canInteractWithPost(req.user as any, postId);
  if (!access.ok) { res.status(access.status || 403).json({ error: access.error }); return; }
  const post = access.post;

  const userId = req.user!.id;

  // Remove any existing reaction from this user on this post
  getDb().prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(userId, postId);

  // Insert new reaction
  getDb().prepare('INSERT INTO likes (user_id, post_id, reaction_type) VALUES (?, ?, ?)').run(userId, postId, reactionType);

  if (post.user_id !== userId) {
    getDb().prepare(`INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'like', ?)`)
      .run(post.user_id, userId, postId);
  }

  // Return grouped counts
  const counts = getReactionCounts(postId);
  res.json({ ok: true, reactionType, counts, userReaction: reactionType });
});

// DELETE /api/likes/:postId — remove all reactions from user on this post
router.delete('/:postId', requireAuth, (req: AuthRequest, res) => {
  const postId = Number(req.params.postId);
  if (!canViewPost(req.user as any, postId)) { res.status(404).json({ error: 'Post not found.' }); return; }
  getDb().prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user!.id, postId);
  const counts = getReactionCounts(postId);
  res.json({ ok: true, counts, userReaction: null });
});

// GET /api/posts/:postId/reactions
router.get('/post/:postId', optionalAuth, (req: AuthRequest, res) => {
  const postId = Number(req.params.postId);
  if (!canViewPost(req.user as any, postId)) { res.status(404).json({ error: 'Post not found.' }); return; }
  const counts = getReactionCounts(postId);
  res.json({ counts });
});

function getReactionCounts(postId: number): Record<string, number> {
  const rows = getDb().prepare(
    'SELECT reaction_type, COUNT(*) as c FROM likes WHERE post_id = ? GROUP BY reaction_type'
  ).all(postId) as any[];
  const counts: Record<string, number> = {};
  for (const r of REACTIONS) counts[r] = 0;
  for (const row of rows) counts[row.reaction_type] = row.c;
  return counts;
}

export { REACTIONS, REACTION_EMOJI };
export default router;
