import { Router } from 'express';
import { requireAuth, type AuthRequest } from '../middleware.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
} from '../notificationService.js';

const router = Router();

// GET /api/notifications
router.get('/', requireAuth, (req: AuthRequest, res) => {
  res.json({ notifications: listNotifications(req.user!) });
});

// GET /api/notifications/unread-count
router.get('/unread-count', requireAuth, (req: AuthRequest, res) => {
  res.json({ count: unreadNotificationCount(req.user!) });
});

// POST /api/notifications/read-all
router.post('/read-all', requireAuth, (req: AuthRequest, res) => {
  const changed = markAllNotificationsRead(req.user!);
  res.json({ ok: true, changed });
});

// PATCH /api/notifications/:id/read
router.patch('/:id/read', requireAuth, (req: AuthRequest, res) => {
  const notificationId = Number(req.params.id);
  if (!Number.isSafeInteger(notificationId) || notificationId <= 0) {
    res.status(404).json({ error: 'Notification not found.' }); return;
  }
  const result = markNotificationRead(req.user!, notificationId);
  if (!result.found) { res.status(404).json({ error: 'Notification not found.' }); return; }
  res.json({ ok: true, changed: result.changed });
});

export default router;
