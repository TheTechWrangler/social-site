import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { canViewUserIdentity, isBlockedBetween, userVisibilitySql } from '../visibility.js';
import { createFollowNotification, removeFollowNotification } from '../notificationService.js';

const router = Router();

type FollowStatus = 'pending' | 'accepted';

function followResponse(status: FollowStatus, replayed: boolean) {
  return {
    ok: true,
    relationshipStatus: status,
    following: status === 'accepted',
    pending: status === 'pending',
    replayed,
  };
}

// GET /api/follows/requests — private inbox for requests addressed to viewer.
router.get('/requests', requireAuth, (req: AuthRequest, res) => {
  const identity = userVisibilitySql(req.user, 'u', 'identity');
  const requests = getDb().prepare(`
    SELECT u.id, u.username, u.display_name AS displayName, u.avatar_url AS avatarUrl,
      f.created_at AS requestedAt
    FROM follows f JOIN users u ON u.id = f.follower_id
    WHERE f.following_id = ? AND f.status = 'pending' AND ${identity.sql}
    ORDER BY f.created_at ASC, u.id ASC
  `).all(req.user!.id, ...identity.params);
  res.json({ requests });
});

// POST /api/follows/requests/:userId/accept — target accepts requester.
router.post('/requests/:userId/accept', requireAuth, (req: AuthRequest, res) => {
  const requesterId = Number(req.params.userId);
  if (!Number.isSafeInteger(requesterId) || requesterId <= 0) {
    res.status(404).json({ error: 'Follow request not found.' }); return;
  }
  const db = getDb();
  const requester = db.prepare('SELECT id, banned FROM users WHERE id = ?').get(requesterId) as any;
  const relationship = db.prepare(`
    SELECT status FROM follows WHERE follower_id = ? AND following_id = ?
  `).get(requesterId, req.user!.id) as { status: FollowStatus } | undefined;
  if (!requester || requester.banned || !relationship || isBlockedBetween(requesterId, req.user!.id)) {
    if (relationship) {
      const removeInvalidRelationship = db.transaction(() => {
        db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
          .run(requesterId, req.user!.id);
        removeFollowNotification(req.user!.id, requesterId);
      });
      removeInvalidRelationship();
    }
    res.status(404).json({ error: 'Follow request not found.' }); return;
  }
  if (relationship.status === 'accepted') {
    res.json(followResponse('accepted', true)); return;
  }
  const accept = db.transaction(() => {
    const updated = db.prepare(`
      UPDATE follows SET status = 'accepted'
      WHERE follower_id = ? AND following_id = ? AND status = 'pending'
    `).run(requesterId, req.user!.id);
    if (updated.changes !== 1) throw new Error('Follow request acceptance did not complete.');
    createFollowNotification(req.user!.id, requesterId);
  });
  accept();
  res.json(followResponse('accepted', false));
});

// DELETE /api/follows/requests/:userId — target declines pending requester.
router.delete('/requests/:userId', requireAuth, (req: AuthRequest, res) => {
  const requesterId = Number(req.params.userId);
  if (!Number.isSafeInteger(requesterId) || requesterId <= 0) {
    res.status(404).json({ error: 'Follow request not found.' }); return;
  }
  const decline = getDb().transaction(() => {
    const declined = getDb().prepare(`
      DELETE FROM follows WHERE follower_id = ? AND following_id = ? AND status = 'pending'
    `).run(requesterId, req.user!.id);
    if (declined.changes === 1) removeFollowNotification(req.user!.id, requesterId);
    return declined;
  });
  const declined = decline();
  if (declined.changes !== 1) {
    res.status(404).json({ error: 'Follow request not found.' }); return;
  }
  res.json({ ok: true, removed: true });
});

// DELETE /api/follows/followers/:userId — target removes an accepted follower.
router.delete('/followers/:userId', requireAuth, (req: AuthRequest, res) => {
  const followerId = Number(req.params.userId);
  if (!Number.isSafeInteger(followerId) || followerId <= 0) {
    res.status(404).json({ error: 'Follower not found.' }); return;
  }
  const removeFollower = getDb().transaction(() => {
    const removed = getDb().prepare(`
      DELETE FROM follows WHERE follower_id = ? AND following_id = ? AND status = 'accepted'
    `).run(followerId, req.user!.id);
    if (removed.changes === 1) removeFollowNotification(req.user!.id, followerId);
    return removed.changes === 1;
  });
  if (!removeFollower()) { res.status(404).json({ error: 'Follower not found.' }); return; }
  res.json({ ok: true, removed: true });
});

// POST /api/follows/:userId
router.post('/:userId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    res.status(404).json({ error: 'User not found.' }); return;
  }
  if (targetId === req.user!.id) { res.status(400).json({ error: 'Cannot follow yourself.' }); return; }

  const target = getDb().prepare(
    'SELECT id, profile_visibility, banned FROM users WHERE id = ?',
  ).get(targetId) as any;
  if (!target || !canViewUserIdentity(req.user as any, target)) {
    res.status(404).json({ error: 'User not found.' }); return;
  }

  try {
    const db = getDb();
    const follow = db.transaction(() => {
      const existing = db.prepare('SELECT status FROM follows WHERE follower_id = ? AND following_id = ?')
        .get(req.user!.id, targetId) as { status: FollowStatus } | undefined;
      const requiredStatus: FollowStatus = target.profile_visibility === 'private' ? 'pending' : 'accepted';
      if (existing) {
        if (existing.status === 'pending' && requiredStatus === 'accepted') {
          db.prepare("UPDATE follows SET status = 'accepted' WHERE follower_id = ? AND following_id = ?")
            .run(req.user!.id, targetId);
          createFollowNotification(targetId, req.user!.id);
          return { status: 'accepted' as const, replayed: false };
        }
        if (existing.status === 'accepted') createFollowNotification(targetId, req.user!.id);
        return { status: existing.status, replayed: true };
      }
      db.prepare('INSERT INTO follows (follower_id, following_id, status) VALUES (?, ?, ?)')
        .run(req.user!.id, targetId, requiredStatus);
      if (requiredStatus === 'accepted') createFollowNotification(targetId, req.user!.id);
      else removeFollowNotification(targetId, req.user!.id);
      return { status: requiredStatus, replayed: false };
    });
    const result = follow();
    res.json(followResponse(result.status, result.replayed));
  } catch (err: any) {
    console.error('[follows] Failed to follow user:', err.message);
    res.status(500).json({ error: 'Could not follow user.' });
  }
});

// DELETE /api/follows/:userId
router.delete('/:userId', requireAuth, (req: AuthRequest, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    res.status(404).json({ error: 'Follow relationship not found.' }); return;
  }
  const unfollow = getDb().transaction(() => {
    const removed = getDb().prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
      .run(req.user!.id, targetId);
    removeFollowNotification(targetId, req.user!.id);
    return removed.changes === 1;
  });
  const removed = unfollow();
  res.json({ ok: true, relationshipStatus: 'none', following: false, pending: false, removed });
});

export default router;
