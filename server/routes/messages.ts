import { feedTimeSql } from '../feedTime.js';
import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import {
  canUserMessageRecipient,
  canViewUserIdentity,
  canViewFullProfile,
  userVisibilitySql,
} from '../visibility.js';
import { logUsage } from '../usageEvents.js';
import { pageInteger } from '../pagination.js';

const router = Router();
const DM_MAX_LENGTH = 2000;

function getVisibleOther(conversationId: number, viewer: NonNullable<AuthRequest['user']>) {
  const visibility = userVisibilitySql(viewer, 'u', 'identity');
  return getDb().prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url
    FROM dm_conversation_members m JOIN users u ON m.user_id = u.id
    WHERE m.conversation_id = ? AND m.user_id != ? AND m.deleted_at IS NULL
      AND ${visibility.sql}
    LIMIT 1
  `).get(conversationId, viewer.id, ...visibility.params) as any;
}

function getMembership(conversationId: number, userId: number) {
  return getDb().prepare(
    'SELECT * FROM dm_conversation_members WHERE conversation_id = ? AND user_id = ? AND deleted_at IS NULL'
  ).get(conversationId, userId) as any;
}

function getLastMessagePreview(conversationId: number) {
  const row = getDb().prepare(
    'SELECT id, sender_id, body, created_at FROM dm_messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(conversationId) as any;
  return row ? {
    id: row.id,
    body: row.body,
    senderId: row.sender_id,
    createdAt: row.created_at,
  } : null;
}

function findExisting1on1(userA: number, userB: number): number | null {
  const row = getDb().prepare(`
    SELECT m1.conversation_id FROM dm_conversation_members m1
    JOIN dm_conversation_members m2 ON m1.conversation_id = m2.conversation_id
    WHERE m1.user_id = ? AND m2.user_id = ?
      AND m1.deleted_at IS NULL AND m2.deleted_at IS NULL
      AND (SELECT COUNT(*) FROM dm_conversation_members
           WHERE conversation_id = m1.conversation_id AND deleted_at IS NULL) = 2
    LIMIT 1
  `).get(userA, userB) as any;
  return row?.conversation_id ?? null;
}

function unreadConversationCount(viewer: NonNullable<AuthRequest['user']>): number {
  const visible = userVisibilitySql(viewer, 'u', 'identity');
  return (getDb().prepare(`
    SELECT COUNT(*) AS count FROM dm_conversation_members m
    WHERE m.user_id = ? AND m.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM dm_messages message
        WHERE message.conversation_id = m.conversation_id AND message.deleted_at IS NULL
          AND message.sender_id != ? AND message.id > COALESCE(m.last_read_message_id, 0))
      AND EXISTS (SELECT 1 FROM dm_conversation_members other_m JOIN users u ON u.id = other_m.user_id
        WHERE other_m.conversation_id = m.conversation_id AND other_m.user_id != ?
          AND other_m.deleted_at IS NULL AND ${visible.sql})
  `).get(viewer.id, viewer.id, viewer.id, ...visible.params) as any).count;
}
router.get('/unread-count', requireAuth, (req: AuthRequest, res) => {
  res.json({ count: unreadConversationCount(req.user!) });
});

// SQL pages visible conversations before hydration; unread badge is not a page count.
router.get('/', requireAuth, (req: AuthRequest, res) => {
  const viewer = req.user!;
  const limit = pageInteger(req.query.limit, 50, 1, 100, 'limit');
  const offset = pageInteger(req.query.offset, 0, 0, 100000, 'offset');
  const visible = userVisibilitySql(viewer, 'u', 'identity');
  const rows = getDb().prepare(`
    SELECT m.conversation_id, u.id AS other_id, u.username, u.display_name, u.avatar_url,
      last.id AS message_id, last.sender_id, last.body, last.created_at,
      (SELECT COUNT(*) FROM dm_messages unread
       WHERE unread.conversation_id = m.conversation_id AND unread.deleted_at IS NULL
         AND unread.sender_id != ? AND unread.id > COALESCE(m.last_read_message_id, 0)) AS unread_count
    FROM dm_conversation_members m
    JOIN users u ON u.id = (
      SELECT other_m.user_id FROM dm_conversation_members other_m JOIN users u ON u.id = other_m.user_id
      WHERE other_m.conversation_id = m.conversation_id AND other_m.user_id != ?
        AND other_m.deleted_at IS NULL AND ${visible.sql}
      ORDER BY other_m.user_id LIMIT 1
    )
    LEFT JOIN dm_messages last ON last.id = (
      SELECT id FROM dm_messages WHERE conversation_id = m.conversation_id
        AND deleted_at IS NULL ORDER BY id DESC LIMIT 1
    )
    WHERE m.user_id = ? AND m.deleted_at IS NULL
    ORDER BY ${feedTimeSql('last.created_at')} DESC, last.id DESC, m.conversation_id DESC
    LIMIT ? OFFSET ?
  `).all(viewer.id, viewer.id, ...visible.params, viewer.id, limit + 1, offset) as any[];
  const conversations = rows.slice(0, limit).map(row => ({
    id: row.conversation_id,
    otherUser: { id: row.other_id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url },
    lastMessage: row.message_id ? { id: row.message_id, senderId: row.sender_id, body: row.body, createdAt: row.created_at } : null,
    unreadCount: row.unread_count,
  }));
  res.json({ conversations, unreadConversationCount: unreadConversationCount(viewer),
    hasMore: rows.length > limit && offset + limit <= 100000,
    nextOffset: rows.length > limit && offset + limit <= 100000 ? offset + limit : null });
});

// POST /api/messages — start or find a 1:1 conversation
router.post('/', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const senderId = req.user!.id;
  const { userId: recipientId } = req.body;

  if (!recipientId || typeof recipientId !== 'number') {
    res.status(400).json({ error: 'userId required.' }); return;
  }
  if (recipientId === senderId) {
    res.status(400).json({ error: 'You cannot message yourself.' }); return;
  }
  const db = getDb();
  const target = db.prepare(
    'SELECT id, profile_visibility, banned, dm_privacy FROM users WHERE id = ?',
  ).get(recipientId) as any;
  if (!target || !canViewUserIdentity(req.user, target)) {
    res.status(404).json({ error: 'User not found.' }); return;
  }
  if (!canUserMessageRecipient(senderId, recipientId)) {
    if (!canViewFullProfile(req.user, target)) {
      res.status(403).json({ error: 'Cannot message this user.' }); return;
    }
    const policy = target?.dm_privacy || 'friends_of_friends';
    const policyLabel: Record<string, string> = {
      noone: 'This user is not accepting messages.',
      friends: 'This user only accepts messages from mutual friends.',
      friends_of_friends: 'This user only accepts messages from friends or friends of friends.',
    };
    res.status(403).json({ error: policyLabel[policy] ?? 'Cannot message this user.' }); return;
  }

  const existing = findExisting1on1(senderId, recipientId);
  if (existing) { res.json({ conversationId: existing }); return; }

  const cid = db.transaction(() => {
    const existing = findExisting1on1(senderId, recipientId);
    if (existing) return existing;
    const conv = db.prepare('INSERT INTO dm_conversations DEFAULT VALUES').run();
    const cid = conv.lastInsertRowid as number;
    db.prepare('INSERT INTO dm_conversation_members (conversation_id, user_id) VALUES (?, ?)').run(cid, senderId);
    db.prepare('INSERT INTO dm_conversation_members (conversation_id, user_id) VALUES (?, ?)').run(cid, recipientId);
    return cid;
  }).immediate();

  res.status(201).json({ conversationId: cid });
});

// GET /api/messages/:conversationId — fetch messages (cursor paginated)
router.get('/:conversationId', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const conversationId = Number(req.params.conversationId);
  if (!conversationId) { res.status(400).json({ error: 'Invalid conversation.' }); return; }

  const membership = getMembership(conversationId, userId);
  if (!membership) { res.status(404).json({ error: 'Conversation not found.' }); return; }

  const before = pageInteger(req.query.before, 0, 1, Number.MAX_SAFE_INTEGER) || null;
  const limit = pageInteger(req.query.limit, 50, 1, 50);

  const db = getDb();
  const other = getVisibleOther(conversationId, req.user!);
  if (!other) {
    res.status(404).json({ error: 'Conversation not found.' }); return;
  }

  const msgs = before
    ? db.prepare(`
        SELECT id, sender_id, body, deleted_at, created_at FROM dm_messages
        WHERE conversation_id = ? AND id < ?
        ORDER BY id DESC LIMIT ?
      `).all(conversationId, before, limit + 1)
    : db.prepare(`
        SELECT id, sender_id, body, deleted_at, created_at FROM dm_messages
        WHERE conversation_id = ?
        ORDER BY id DESC LIMIT ?
      `).all(conversationId, limit + 1);

  // Return oldest-first for display; query is newest-first for cursor efficiency
  const messages = (msgs as any[]).slice(0, limit).reverse().map(m => ({
    id: m.id,
    senderId: m.sender_id,
    body: m.deleted_at ? null : m.body,
    isDeleted: !!m.deleted_at,
    createdAt: m.created_at,
  }));

  res.json({
    messages,
    hasMore: msgs.length > limit,
    otherUser: {
      id: other.id,
      username: other.username,
      displayName: other.display_name,
      avatarUrl: other.avatar_url,
    },
    lastReadMessageId: membership.last_read_message_id ?? null,
  });
});

// POST /api/messages/:conversationId — send a message
router.post('/:conversationId', requireAuth, requireVerified, (req: AuthRequest, res) => {
  const senderId = req.user!.id;
  const conversationId = Number(req.params.conversationId);
  if (!conversationId) { res.status(400).json({ error: 'Invalid conversation.' }); return; }

  const membership = getMembership(conversationId, senderId);
  if (!membership) { res.status(404).json({ error: 'Conversation not found.' }); return; }

  const visibleOther = getVisibleOther(conversationId, req.user!);
  if (!visibleOther) { res.status(404).json({ error: 'Conversation not found.' }); return; }

  const body = String(req.body.body || '').trim();
  if (!body) { res.status(400).json({ error: 'Message cannot be empty.' }); return; }
  if (body.length > DM_MAX_LENGTH) {
    res.status(400).json({ error: `Message must be ${DM_MAX_LENGTH} characters or fewer.` }); return;
  }

  // Re-check recipient's privacy setting on every send
  const db = getDb();
  if (!canUserMessageRecipient(senderId, visibleOther.id)) {
    res.status(403).json({ error: 'This user\'s message settings no longer allow incoming messages.' }); return;
  }

  const result = db.prepare(
    'INSERT INTO dm_messages (conversation_id, sender_id, body) VALUES (?, ?, ?)'
  ).run(conversationId, senderId, body);

  const msg = db.prepare('SELECT id, sender_id, body, created_at FROM dm_messages WHERE id = ?').get(result.lastInsertRowid) as any;
  logUsage({ eventType: 'message_sent', userId: senderId, featureArea: 'messages' });
  res.status(201).json({
    message: {
      id: msg.id,
      senderId: msg.sender_id,
      body: msg.body,
      isDeleted: false,
      createdAt: msg.created_at,
    }
  });
});

// POST /api/messages/:conversationId/read — mark conversation read
router.post('/:conversationId/read', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const conversationId = Number(req.params.conversationId);
  if (!conversationId) { res.status(400).json({ error: 'Invalid conversation.' }); return; }

  const membership = getMembership(conversationId, userId);
  if (!membership) { res.status(404).json({ error: 'Conversation not found.' }); return; }
  if (!getVisibleOther(conversationId, req.user!)) {
    res.status(404).json({ error: 'Conversation not found.' }); return;
  }

  const observedMessageId = Number(req.body?.observedMessageId);
  if (!Number.isSafeInteger(observedMessageId) || observedMessageId <= 0) {
    res.status(400).json({ error: 'A valid observedMessageId is required.' }); return;
  }
  const observed = getDb().prepare(
    'SELECT id FROM dm_messages WHERE id = ? AND conversation_id = ?'
  ).get(observedMessageId, conversationId) as any;
  if (!observed) { res.status(404).json({ error: 'Message not found.' }); return; }

  getDb().prepare(
    `UPDATE dm_conversation_members
     SET last_read_message_id = CASE
       WHEN last_read_message_id IS NULL OR last_read_message_id < ? THEN ?
       ELSE last_read_message_id
     END
     WHERE conversation_id = ? AND user_id = ?`
  ).run(observedMessageId, observedMessageId, conversationId, userId);
  const updated = getMembership(conversationId, userId);
  res.json({ ok: true, lastReadMessageId: updated.last_read_message_id });
});

// DELETE /api/messages/:conversationId/messages/:messageId — soft-delete own message
router.delete('/:conversationId/messages/:messageId', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const conversationId = Number(req.params.conversationId);
  const messageId = Number(req.params.messageId);
  if (!conversationId || !messageId) { res.status(400).json({ error: 'Invalid parameters.' }); return; }

  const membership = getMembership(conversationId, userId);
  if (!membership) { res.status(404).json({ error: 'Conversation not found.' }); return; }
  if (!getVisibleOther(conversationId, req.user!)) {
    res.status(404).json({ error: 'Conversation not found.' }); return;
  }

  const msg = getDb().prepare(
    'SELECT id, sender_id, deleted_at FROM dm_messages WHERE id = ? AND conversation_id = ?'
  ).get(messageId, conversationId) as any;
  if (!msg) { res.status(404).json({ error: 'Message not found.' }); return; }
  if (msg.sender_id !== userId) { res.status(403).json({ error: 'You can only delete your own messages.' }); return; }
  if (msg.deleted_at) { res.status(400).json({ error: 'Message already deleted.' }); return; }

  getDb().prepare("UPDATE dm_messages SET deleted_at = datetime('now') WHERE id = ?").run(messageId);
  res.json({ ok: true, lastMessage: getLastMessagePreview(conversationId) });
});

export default router;
