import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { canInteractWithPost, canViewPost, userVisibilitySql, type Viewer } from '../visibility.js';
import { logUsage } from '../usageEvents.js';
import { createReactionNotification, removeReactionNotification } from '../notificationService.js';

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
  const db = getDb();
  const setReaction = db.transaction(() => {
    const existingReaction = db.prepare('SELECT reaction_type FROM likes WHERE user_id = ? AND post_id = ?')
      .get(userId, postId) as { reaction_type: string } | undefined;
    const reactionChanged = existingReaction?.reaction_type !== reactionType;
    if (reactionChanged) {
      db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(userId, postId);
      db.prepare('INSERT INTO likes (user_id, post_id, reaction_type) VALUES (?, ?, ?)').run(userId, postId, reactionType);
    }
    createReactionNotification(post.user_id, userId, postId);
    return reactionChanged;
  });
  const reactionChanged = setReaction();
  if (reactionChanged) logUsage({ eventType: 'like_created', userId: req.user!.id, featureArea: 'feed' });

  // Return grouped counts
  const counts = getReactionCounts(postId, req.user);
  res.json({ ok: true, reactionType, counts, userReaction: reactionType });
});

// DELETE /api/likes/:postId — remove all reactions from user on this post
router.delete('/:postId', requireAuth, (req: AuthRequest, res) => {
  const postId = Number(req.params.postId);
  if (!canViewPost(req.user as any, postId)) { res.status(404).json({ error: 'Post not found.' }); return; }
  const removeReaction = getDb().transaction(() => {
    getDb().prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user!.id, postId);
    removeReactionNotification(req.user!.id, postId);
  });
  removeReaction();
  const counts = getReactionCounts(postId, req.user);
  res.json({ ok: true, counts, userReaction: null });
});

// GET /api/posts/:postId/reactions
router.get('/post/:postId', optionalAuth, (req: AuthRequest, res) => {
  const postId = Number(req.params.postId);
  if (!canViewPost(req.user as any, postId)) { res.status(404).json({ error: 'Post not found.' }); return; }
  const counts = getReactionCounts(postId, req.user);
  res.json({ counts });
});

function getReactionCounts(postId: number, viewer?: Viewer | null): Record<string, number> {
  const reactionUser = userVisibilitySql(viewer, 'u', 'identity');
  const rows = getDb().prepare(`
    SELECT l.reaction_type, COUNT(*) as c
    FROM likes l JOIN users u ON l.user_id = u.id
    WHERE l.post_id = ? AND ${reactionUser.sql}
    GROUP BY l.reaction_type
  `).all(postId, ...reactionUser.params) as any[];
  const counts: Record<string, number> = {};
  for (const r of REACTIONS) counts[r] = 0;
  for (const row of rows) counts[row.reaction_type] = row.c;
  return counts;
}

export { REACTIONS, REACTION_EMOJI };
export default router;
