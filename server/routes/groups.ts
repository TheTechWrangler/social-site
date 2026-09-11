import { pageInteger } from '../pagination.js';
import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPosts } from './posts.js';
import { logUsage } from '../usageEvents.js';
import {
  notMutedByViewerSql,
  userVisibilitySql,
} from '../visibility.js';

const router = Router();

const GROUP_NAME_MAX = 80;
const GROUP_DESC_MAX = 400;

// POST /api/groups
router.post('/', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) { res.status(400).json({ error: 'Name required.' }); return; }
  const trimmedName = name.trim().slice(0, GROUP_NAME_MAX);
  const trimmedDesc = (description || '').trim().slice(0, GROUP_DESC_MAX);
  const createGroup = getDb().transaction(() => {
    const result = getDb().prepare(
      'INSERT INTO groups_table (name, description, owner_id) VALUES (?, ?, ?)'
    ).run(trimmedName, trimmedDesc, req.user!.id);
    const groupId = Number(result.lastInsertRowid);
    getDb().prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)')
      .run(groupId, req.user!.id, 'admin');
    return groupId;
  });
  const groupId = createGroup();
  logUsage({ eventType: 'group_created', userId: req.user!.id, featureArea: 'groups' });
  res.status(201).json({ group: { id: groupId, name: trimmedName, description: trimmedDesc, ownerId: req.user!.id } });
});

// GET /api/groups — with optional ?q= search and is_member flag
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  const q = (req.query.q as string || '').trim();
  const viewerId = req.user?.id ?? 0;
  const ownerVisibility = userVisibilitySql(req.user as any, 'u', 'public-context');
  const memberVisibility = userVisibilitySql(req.user as any, 'mu', 'identity');
  const sql = `
    SELECT g.*, u.username as owner_username, u.display_name as owner_name,
      (
        SELECT COUNT(*) FROM group_members mg
        JOIN users mu ON mg.user_id = mu.id
        WHERE mg.group_id = g.id AND ${memberVisibility.sql}
      ) as member_count,
      (SELECT 1 FROM group_members WHERE group_id = g.id AND user_id = ?) as is_member
    FROM groups_table g JOIN users u ON g.owner_id = u.id
    WHERE ${ownerVisibility.sql}
      ${q ? 'AND (g.name LIKE ? OR g.description LIKE ?)' : ''}
    ORDER BY g.created_at DESC LIMIT 50
  `;
  const rows = q
    ? getDb().prepare(sql).all(
        ...memberVisibility.params,
        viewerId,
        ...ownerVisibility.params,
        `%${q}%`,
        `%${q}%`,
      )
    : getDb().prepare(sql).all(
        ...memberVisibility.params,
        viewerId,
        ...ownerVisibility.params,
      );
  res.json({ groups: rows });
});

// GET /api/groups/:id
router.get('/:id', optionalAuth, (req: AuthRequest, res) => {
  const ownerVisibility = userVisibilitySql(req.user as any, 'u', 'public-context');
  const group = getDb().prepare(`
    SELECT g.*, u.username as owner_username, u.display_name as owner_name
    FROM groups_table g JOIN users u ON g.owner_id = u.id
    WHERE g.id = ? AND ${ownerVisibility.sql}
  `).get(req.params.id, ...ownerVisibility.params) as any;
  if (!group) { res.status(404).json({ error: 'Not found.' }); return; }

  const limit = pageInteger(req.query.limit, 50, 1, 100, 'limit');
  const after = pageInteger(req.query.memberAfter, 0, 1, Number.MAX_SAFE_INTEGER, 'memberAfter');
  const memberIdentity = userVisibilitySql(req.user as any, 'u', 'identity');
  const memberFull = userVisibilitySql(req.user as any, 'u', 'profile');
  const members = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, gm.role,
      (u.id = ?) as is_self,
      CASE WHEN (${memberFull.sql}) THEN 1 ELSE 0 END AS can_view_full
    FROM group_members gm JOIN users u ON gm.user_id = u.id
    WHERE gm.group_id = ? AND u.id > ? AND ${memberIdentity.sql}
    ORDER BY u.id ASC LIMIT ?
  `).all(
    req.user?.id ?? 0,
    ...memberFull.params,
    req.params.id,
    after, ...memberIdentity.params, limit + 1,
  ) as any[];

  const postAuthor = userVisibilitySql(req.user as any, 'u', 'public-context');
  const notMuted = notMutedByViewerSql(req.user as any, 'u');
  const posts = after ? [] : getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.group_id = ? AND p.parent_id IS NULL AND p.hidden = 0
      AND ${postAuthor.sql}
      AND ${notMuted.sql}
    ORDER BY p.created_at DESC LIMIT 50
  `).all(req.params.id, ...postAuthor.params, ...notMuted.params);

  res.json({
    group: { ...group,
      memberCount: (getDb().prepare(`SELECT COUNT(*) AS count FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? AND ${memberIdentity.sql}`).get(group.id, ...memberIdentity.params) as any).count,
      memberRole: (getDb().prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(group.id, req.user?.id ?? 0) as any)?.role ?? null,
    },
    membersPage: { hasMore: members.length > limit, nextCursor: members.length > limit ? members[limit - 1].id : null },
    members: members.slice(0, limit).map(member => member.can_view_full ? {
      id: member.id,
      username: member.username,
      display_name: member.display_name,
      avatar_url: member.avatar_url,
      role: member.role,
      is_self: member.is_self,
    } : {
      id: member.id,
      username: member.username,
      display_name: member.display_name,
      avatar_url: member.avatar_url,
      limited: true,
    }),
    posts: enrichPosts(posts, req.user as any),
  });
});

// POST /api/groups/:id/join
router.post('/:id/join', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const ownerVisibility = userVisibilitySql(req.user, 'u', 'public-context');
  const group = getDb().prepare(`
    SELECT g.id FROM groups_table g JOIN users u ON u.id = g.owner_id
    WHERE g.id = ? AND ${ownerVisibility.sql}
  `).get(req.params.id, ...ownerVisibility.params);
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  getDb().prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)')
    .run(Number(req.params.id), req.user!.id);
  res.json({ ok: true });
});

// POST /api/groups/:id/leave
router.post('/:id/leave', requireAuth, (req: AuthRequest, res) => {
  const group = getDb().prepare('SELECT owner_id FROM groups_table WHERE id = ?').get(req.params.id) as any;
  // Leaving is idempotent self-management, including missing/nonmember groups.
  if (group?.owner_id === req.user!.id) {
    res.status(409).json({ error: 'Transfer ownership before leaving, or delete the group.' });
    return;
  }
  getDb().prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user!.id);
  res.json({ ok: true });
});


// PUT /api/groups/:id/owner — atomically transfer the single owner authority.
// The owner is represented by groups_table.owner_id; membership roles remain
// the existing member/mod/admin model, so both the new and previous owner are
// group admins after transfer.
router.put('/:id/owner', requireAuth, (req: AuthRequest, res) => {
  const groupId = Number(req.params.id);
  const targetUserId = Number(req.body?.userId);
  if (!Number.isSafeInteger(groupId) || groupId <= 0 ||
      !Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    res.status(400).json({ error: 'Invalid ownership transfer.' });
    return;
  }
  const viewer = req.user!;
  try {
    const transferOwnership = getDb().transaction(() => {
      const group = getDb().prepare('SELECT id, owner_id FROM groups_table WHERE id = ?')
        .get(groupId) as any;
      if (!group || (group.owner_id !== viewer.id && viewer.role !== 'admin')) {
        return { status: 404, error: 'Group not found.' };
      }
      const target = getDb().prepare(`
        SELECT u.id, u.username, u.display_name
        FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND gm.user_id = ? AND u.banned = 0
      `).get(groupId, targetUserId) as any;
      if (!target) return { status: 404, error: 'Eligible group member not found.' };

      if (group.owner_id === targetUserId) {
        getDb().prepare(`
          UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?
        `).run(groupId, targetUserId);
        return { status: 200, target, previousOwnerId: group.owner_id, replayed: true };
      }

      // Heal a legacy missing owner-membership row inside the same transaction;
      // normal creation already guarantees it exists.
      getDb().prepare(`
        INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')
      `).run(groupId, group.owner_id);
      getDb().prepare(`
        UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id IN (?, ?)
      `).run(groupId, targetUserId, group.owner_id);
      const updated = getDb().prepare(`
        UPDATE groups_table SET owner_id = ? WHERE id = ? AND owner_id = ?
      `).run(targetUserId, groupId, group.owner_id);
      if (updated.changes !== 1) throw new Error('Group ownership changed concurrently.');
      return { status: 200, target, previousOwnerId: group.owner_id, replayed: false };
    });
    const result = transferOwnership();
    if (!result.target) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    logUsage({ eventType: 'group_ownership_transferred', userId: viewer.id, featureArea: 'groups' });
    res.json({
      ok: true,
      owner: result.target,
      previousOwnerId: result.previousOwnerId,
      previousOwnerRole: 'admin',
      replayed: result.replayed,
    });
  } catch (err: any) {
    console.error('[groups] Ownership transfer error:', err.message);
    res.status(500).json({ error: 'Could not transfer group ownership.' });
  }
});

// DELETE /api/groups/:id — owner or site administrator deletes the complete
// group-scoped publication graph. Foreign-key cascades remove memberships,
// posts and descendants; Batch 06 triggers detach managed media references.
router.delete('/:id', requireAuth, (req: AuthRequest, res) => {
  const groupId = Number(req.params.id);
  if (!Number.isSafeInteger(groupId) || groupId <= 0) {
    res.status(404).json({ error: 'Group not found.' });
    return;
  }
  const viewer = req.user!;
  try {
    const deleteGroup = getDb().transaction(() => {
      const group = getDb().prepare('SELECT id, name, owner_id FROM groups_table WHERE id = ?')
        .get(groupId) as any;
      if (!group || (group.owner_id !== viewer.id && viewer.role !== 'admin')) return null;
      const memberCount = (getDb().prepare(
        'SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?'
      ).get(groupId) as any).c as number;
      const postCount = (getDb().prepare(
        'SELECT COUNT(*) AS c FROM posts WHERE group_id = ?'
      ).get(groupId) as any).c as number;
      const deleted = getDb().prepare('DELETE FROM groups_table WHERE id = ?').run(groupId);
      if (deleted.changes !== 1) throw new Error('Group deletion did not complete.');
      return { name: group.name as string, memberCount, postCount };
    });
    const result = deleteGroup();
    if (!result) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }
    logUsage({ eventType: 'group_deleted', userId: viewer.id, featureArea: 'groups' });
    res.json({
      ok: true,
      deleted: {
        groupId,
        name: result.name,
        memberCount: result.memberCount,
        groupPostCount: result.postCount,
        contentPolicy: 'group-scoped-content-deleted',
      },
    });
  } catch (err: any) {
    console.error('[groups] Delete group error:', err.message);
    res.status(500).json({ error: 'Could not delete group.' });
  }
});

// DELETE /api/groups/:id/members/:userId — owner or site-admin removes a member
router.delete('/:id/members/:userId', requireAuth, (req: AuthRequest, res) => {
  const viewer = req.user!;
  const group = getDb().prepare(`
    SELECT g.owner_id FROM groups_table g
    WHERE g.id = ? AND (
      g.owner_id = ?
      OR ? = 'admin'
      OR EXISTS (
        SELECT 1 FROM group_members gm
        WHERE gm.group_id = g.id AND gm.user_id = ? AND gm.role = 'admin'
      )
    )
  `).get(req.params.id, viewer.id, viewer.role, viewer.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  const targetId = Number(req.params.userId);
  if (targetId === group.owner_id) {
    res.status(400).json({ error: 'Cannot remove the group owner.' }); return;
  }
  getDb().prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, targetId);
  res.json({ ok: true });
});

export default router;
