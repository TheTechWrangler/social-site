import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';
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
  const result = getDb().prepare(
    'INSERT INTO groups_table (name, description, owner_id) VALUES (?, ?, ?)'
  ).run(trimmedName, trimmedDesc, req.user!.id);
  const groupId = result.lastInsertRowid as number;
  getDb().prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)')
    .run(groupId, req.user!.id, 'admin');
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

  const memberIdentity = userVisibilitySql(req.user as any, 'u', 'identity');
  const memberFull = userVisibilitySql(req.user as any, 'u', 'profile');
  const members = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, gm.role,
      (u.id = ?) as is_self,
      CASE WHEN (${memberFull.sql}) THEN 1 ELSE 0 END AS can_view_full
    FROM group_members gm JOIN users u ON gm.user_id = u.id
    WHERE gm.group_id = ? AND ${memberIdentity.sql}
    ORDER BY gm.role DESC, u.display_name COLLATE NOCASE
  `).all(
    req.user?.id ?? 0,
    ...memberFull.params,
    req.params.id,
    ...memberIdentity.params,
  ) as any[];

  const postAuthor = userVisibilitySql(req.user as any, 'u', 'public-context');
  const notMuted = notMutedByViewerSql(req.user as any, 'u');
  const posts = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.group_id = ? AND p.parent_id IS NULL AND p.hidden = 0
      AND ${postAuthor.sql}
      AND ${notMuted.sql}
    ORDER BY p.created_at DESC LIMIT 50
  `).all(req.params.id, ...postAuthor.params, ...notMuted.params);

  res.json({
    group: { ...group, memberCount: members.length },
    members: members.map(member => member.can_view_full ? {
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
    posts: posts.map((r: any) => enrichPost(r, req.user as any)),
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
    res.status(403).json({ error: 'You own this group and cannot leave. Delete the group to remove it.' });
    return;
  }
  getDb().prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?')
    .run(Number(req.params.id), req.user!.id);
  res.json({ ok: true });
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
