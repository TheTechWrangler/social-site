import { Router } from 'express';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import {
  canUserMessageRecipient,
  getUserVisibility,
  isBlockedBetween,
  userVisibilitySql,
} from '../visibility.js';
import { logUsage } from '../usageEvents.js';

const router = Router();
const DM_MAX_LENGTH = 2000;

function getMembership(conversationId: number, userId: number) {
  return getDb().prepare(
    'SELECT * FROM dm_conversation_members WHERE conversation_id = ? AND user_id = ? AND deleted_at IS NULL'
  ).get(conversationId, userId) as any;
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

// GET /api/messages/unread-count  (must be before /:conversationId)
router.get('/unread-count', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const visibleOther = userVisibilitySql(req.user, 'u', 'identity');
  const rows = getDb().prepare(`
    SELECT m.conversation_id, m.last_read_message_id,
      (SELECT COUNT(*) FROM dm_messages
       WHERE conversation_id = m.conversation_id
         AND deleted_at IS NULL
         AND sender_id != ?
         AND (m.last_read_message_id IS NULL OR id > m.last_read_message_id)
      ) as unread
    FROM dm_conversation_members m
    WHERE m.user_id = ? AND m.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM dm_conversation_members other_m
        JOIN users u ON u.id = other_m.user_id
        WHERE other_m.conversation_id = m.conversation_id
          AND other_m.user_id != ?
          AND other_m.deleted_at IS NULL
          AND ${visibleOther.sql}
      )
  `).all(userId, userId, userId, ...visibleOther.params) as any[];
  const total = rows.reduce((sum, r) => sum + (r.unread > 0 ? 1 : 0), 0);
  res.json({ count: total });
});

// GET /api/messages — list my conversations
router.get('/', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const db = getDb();

  const convIds = (db.prepare(
    'SELECT conversation_id FROM dm_conversation_members WHERE user_id = ? AND deleted_at IS NULL ORDER BY conversation_id DESC'
  ).all(userId) as any[]).map(r => r.conversation_id);

  const conversations = convIds.map(cid => {
    const me = db.prepare(
      'SELECT last_read_message_id FROM dm_conversation_members WHERE conversation_id = ? AND user_id = ?'
    ).get(cid, userId) as any;

    const other = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified,
        u.profile_visibility, u.banned
      FROM dm_conversation_members m JOIN users u ON m.user_id = u.id
      WHERE m.conversation_id = ? AND m.user_id != ? AND m.deleted_at IS NULL
      LIMIT 1
    `).get(cid, userId) as any;
    if (!other || getUserVisibility(req.user, other) === 'hidden') return null;

    const lastMsg = db.prepare(
      'SELECT id, sender_id, body, created_at FROM dm_messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1'
    ).get(cid) as any;

    const unread = (db.prepare(`
      SELECT COUNT(*) as c FROM dm_messages
      WHERE conversation_id = ? AND deleted_at IS NULL AND sender_id != ?
        AND (? IS NULL OR id > ?)
    `).get(cid, userId, me?.last_read_message_id ?? null, me?.last_read_message_id ?? null) as any)?.c ?? 0;

    return {
      id: cid,
      otherUser: {
        id: other.id,
        username: other.username,
        displayName: other.display_name,
        avatarUrl: other.avatar_url,
        isVerified: !!other.is_verified,
      },
      lastMessage: lastMsg ? {
        id: lastMsg.id,
        body: lastMsg.deleted_at ? null : lastMsg.body,
        senderId: lastMsg.sender_id,
        createdAt: lastMsg.created_at,
      } : null,
      unreadCount: unread,
    };
  }).filter(Boolean);

  // Sort: conversations with messages by last message desc, then by conversation id desc
  conversations.sort((a: any, b: any) => {
    const aTime = a.lastMessage?.createdAt ?? '';
    const bTime = b.lastMessage?.createdAt ?? '';
    return bTime.localeCompare(aTime) || b.id - a.id;
  });

  res.json({ conversations });
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
  if (isBlockedBetween(senderId, recipientId)) {
    res.status(403).json({ error: 'Cannot start a conversation with this user.' }); return;
  }
  if (!canUserMessageRecipient(senderId, recipientId)) {
    const db = getDb();
    const target = db.prepare('SELECT dm_privacy FROM users WHERE id = ?').get(recipientId) as any;
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

  const db = getDb();
  const conv = db.prepare('INSERT INTO dm_conversations DEFAULT VALUES').run();
  const cid = conv.lastInsertRowid as number;
  db.prepare('INSERT INTO dm_conversation_members (conversation_id, user_id) VALUES (?, ?)').run(cid, senderId);
  db.prepare('INSERT INTO dm_conversation_members (conversation_id, user_id) VALUES (?, ?)').run(cid, recipientId);

  res.status(201).json({ conversationId: cid });
});

// GET /api/messages/:conversationId — fetch messages (cursor paginated)
router.get('/:conversationId', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const conversationId = Number(req.params.conversationId);
  if (!conversationId) { res.status(400).json({ error: 'Invalid conversation.' }); return; }

  const membership = getMembership(conversationId, userId);
  if (!membership) { res.status(404).json({ error: 'Conversation not found.' }); return; }

  const before = req.query.before ? Number(req.query.before) : null;
  const limit = Math.min(Number(req.query.limit) || 50, 50);

  const db = getDb();
  const other = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_verified, u.dm_privacy,
      u.profile_visibility, u.banned
    FROM dm_conversation_members m JOIN users u ON m.user_id = u.id
    WHERE m.conversation_id = ? AND m.user_id != ? AND m.deleted_at IS NULL
    LIMIT 1
  `).get(conversationId, userId) as any;
  if (!other || getUserVisibility(req.user, other) === 'hidden') {
    res.status(404).json({ error: 'Conversation not found.' }); return;
  }

  const msgs = before
    ? db.prepare(`
        SELECT id, sender_id, body, deleted_at, created_at FROM dm_messages
        WHERE conversation_id = ? AND id < ?
        ORDER BY id DESC LIMIT ?
      `).all(conversationId, before, limit)
    : db.prepare(`
        SELECT id, sender_id, body, deleted_at, created_at FROM dm_messages
        WHERE conversation_id = ?
        ORDER BY id DESC LIMIT ?
      `).all(conversationId, limit);

  // Return oldest-first for display; query is newest-first for cursor efficiency
  const messages = (msgs as any[]).reverse().map(m => ({
    id: m.id,
    senderId: m.sender_id,
    body: m.deleted_at ? null : m.body,
    isDeleted: !!m.deleted_at,
    createdAt: m.created_at,
  }));

  res.json({
    messages,
    hasMore: msgs.length === limit,
    otherUser: {
      id: other.id,
      username: other.username,
      displayName: other.display_name,
      avatarUrl: other.avatar_url,
      isVerified: !!other.is_verified,
      dmPrivacy: other.dm_privacy,
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

  const body = String(req.body.body || '').trim();
  if (!body) { res.status(400).json({ error: 'Message cannot be empty.' }); return; }
  if (body.length > DM_MAX_LENGTH) {
    res.status(400).json({ error: `Message must be ${DM_MAX_LENGTH} characters or fewer.` }); return;
  }

  // Re-check recipient's privacy setting on every send
  const db = getDb();
  const other = db.prepare(
    'SELECT user_id FROM dm_conversation_members WHERE conversation_id = ? AND user_id != ? AND deleted_at IS NULL'
  ).get(conversationId, senderId) as any;
  if (!other) { res.status(400).json({ error: 'Conversation has no other participant.' }); return; }

  if (isBlockedBetween(senderId, other.user_id)) {
    res.status(403).json({ error: 'Cannot send messages to this user.' }); return;
  }
  if (!canUserMessageRecipient(senderId, other.user_id)) {
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

  const lastMsg = getDb().prepare(
    'SELECT id FROM dm_messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get(conversationId) as any;

  if (lastMsg) {
    getDb().prepare(
      'UPDATE dm_conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?'
    ).run(lastMsg.id, conversationId, userId);
  }
  res.json({ ok: true });
});

// DELETE /api/messages/:conversationId/messages/:messageId — soft-delete own message
router.delete('/:conversationId/messages/:messageId', requireAuth, (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const conversationId = Number(req.params.conversationId);
  const messageId = Number(req.params.messageId);
  if (!conversationId || !messageId) { res.status(400).json({ error: 'Invalid parameters.' }); return; }

  const membership = getMembership(conversationId, userId);
  if (!membership) { res.status(404).json({ error: 'Conversation not found.' }); return; }

  const msg = getDb().prepare(
    'SELECT id, sender_id, deleted_at FROM dm_messages WHERE id = ? AND conversation_id = ?'
  ).get(messageId, conversationId) as any;
  if (!msg) { res.status(404).json({ error: 'Message not found.' }); return; }
  if (msg.sender_id !== userId) { res.status(403).json({ error: 'You can only delete your own messages.' }); return; }
  if (msg.deleted_at) { res.status(400).json({ error: 'Message already deleted.' }); return; }

  getDb().prepare("UPDATE dm_messages SET deleted_at = datetime('now') WHERE id = ?").run(messageId);
  res.json({ ok: true });
});

export default router;
