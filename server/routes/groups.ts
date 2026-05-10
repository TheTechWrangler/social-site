import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, optionalAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';

const router = Router();

// POST /api/groups
router.post('/', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) { res.status(400).json({ error: 'Name required.' }); return; }
  const result = getDb().prepare(
    'INSERT INTO groups_table (name, description, owner_id) VALUES (?, ?, ?)'
  ).run(name.trim(), description || '', req.user!.id);
  const groupId = result.lastInsertRowid as number;
  getDb().prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)')
    .run(groupId, req.user!.id, 'admin');
  res.status(201).json({ group: { id: groupId, name: name.trim(), description: description || '', ownerId: req.user!.id } });
});

// GET /api/groups
router.get('/', optionalAuth, (_req, res) => {
  const rows = getDb().prepare(`
    SELECT g.*, u.username as owner_username, u.display_name as owner_name,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count
    FROM groups_table g JOIN users u ON g.owner_id = u.id ORDER BY g.created_at DESC LIMIT 30
  `).all();
  res.json({ groups: rows });
});

// GET /api/groups/:id
router.get('/:id', optionalAuth, (req: AuthRequest, res) => {
  const group = getDb().prepare('SELECT * FROM groups_table WHERE id = ?').get(req.params.id) as any;
  if (!group) { res.status(404).json({ error: 'Not found.' }); return; }

  const members = getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, gm.role
    FROM group_members gm JOIN users u ON gm.user_id = u.id WHERE gm.group_id = ?
  `).all(req.params.id);

  // Group feed
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
  getDb().prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)')
    .run(Number(req.params.id), req.user!.id);
  res.json({ ok: true });
});

// POST /api/groups/:id/leave
router.post('/:id/leave', requireAuth, requireVerified, (req: AuthRequest, res) => {
  getDb().prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND role != ?')
    .run(Number(req.params.id), req.user!.id, 'admin');
  res.json({ ok: true });
});

export default router;
