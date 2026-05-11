import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';

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
  res.status(201).json({ group: { id: groupId, name: trimmedName, description: trimmedDesc, ownerId: req.user!.id } });
});

// GET /api/groups — with optional ?q= search and is_member flag
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  const q = (req.query.q as string || '').trim();
  const viewerId = req.user?.id ?? 0;
  const sql = `
    SELECT g.*, u.username as owner_username, u.display_name as owner_name,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
      (SELECT 1 FROM group_members WHERE group_id = g.id AND user_id = ?) as is_member
    FROM groups_table g JOIN users u ON g.owner_id = u.id
    ${q ? 'WHERE g.name LIKE ? OR g.description LIKE ?' : ''}
    ORDER BY g.created_at DESC LIMIT 50
  `;
  const rows = q
    ? getDb().prepare(sql).all(viewerId, `%${q}%`, `%${q}%`)
    : getDb().prepare(sql).all(viewerId);
  res.json({ groups: rows });
});

// GET /api/groups/:id
router.get('/:id', optionalAuth, (req: AuthRequest, res) => {
  const group = getDb().prepare(`
    SELECT g.*, u.username as owner_username, u.display_name as owner_name
    FROM groups_table g JOIN users u ON g.owner_id = u.id WHERE g.id = ?
  `).get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Not found.' }); return; }

  const members = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, gm.role,
      (u.id = ?) as is_self
    FROM group_members gm JOIN users u ON gm.user_id = u.id
    WHERE gm.group_id = ? AND u.banned = 0
    ORDER BY gm.role DESC, u.display_name COLLATE NOCASE
  `).all(req.user?.id ?? 0, req.params.id);

  const posts = getDb().prepare(`
    SELECT p.*, u.username, u.display_name, u.avatar_url
    FROM posts p JOIN users u ON p.user_id = u.id
    WHERE p.group_id = ? AND p.parent_id IS NULL AND p.hidden = 0
    ORDER BY p.created_at DESC LIMIT 50
  `).all(req.params.id);

  res.json({
    group: { ...group, memberCount: members.length },
    members,
    posts: posts.map((r: any) => enrichPost(r, req.user?.id)),
  });
});

// POST /api/groups/:id/join
router.post('/:id/join', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const group = getDb().prepare('SELECT id FROM groups_table WHERE id = ?').get(req.params.id);
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  getDb().prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)')
    .run(Number(req.params.id), req.user!.id);
  res.json({ ok: true });
});

// POST /api/groups/:id/leave
router.post('/:id/leave', requireAuth, (req: AuthRequest, res) => {
  const group = getDb().prepare('SELECT owner_id FROM groups_table WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  if (group.owner_id === req.user!.id) {
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
  const group = getDb().prepare('SELECT owner_id FROM groups_table WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Group not found.' }); return; }
  const targetId = Number(req.params.userId);
  if (targetId === group.owner_id) {
    res.status(400).json({ error: 'Cannot remove the group owner.' }); return;
  }
  const viewerRole = (getDb().prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(req.params.id, viewer.id) as any)?.role;
  const canManage = group.owner_id === viewer.id || viewerRole === 'admin' || viewer.role === 'admin';
  if (!canManage) { res.status(403).json({ error: 'Not authorized.' }); return; }
  getDb().prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, targetId);
  res.json({ ok: true });
});

export default router;
