import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { getDb } from '../database.js';
import { requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { canViewPost } from '../visibility.js';

const router = Router();
const REPORT_ERROR = 'Please select a reason and briefly explain the problem.';
const CONTENT_UNAVAILABLE = 'Content not found or unavailable.';
const REPORT_REASONS = new Set([
  'Spam',
  'Harassment',
  'Hate or abuse',
  'Sexual content',
  'Violence or threats',
  'Scam or unsafe link',
  'Other',
]);

function positiveEnvInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const reportLimiter = rateLimit({
  windowMs: positiveEnvInt('RATE_LIMIT_WRITE_WINDOW_MINUTES', 15) * 60 * 1000,
  max: positiveEnvInt('RATE_LIMIT_REPORT_MAX', 10),
  message: { error: 'Too many reports submitted. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.RATE_LIMIT_ENABLED === 'false',
});

router.post('/', requireAuth, requireVerified, reportLimiter, (req: AuthRequest, res) => {
  const targetType = req.body?.targetType;
  const targetId = Number(req.body?.targetId);
  const reason = String(req.body?.reason || '').trim().slice(0, 120);
  const details = String(req.body?.details ?? req.body?.report_details ?? '').trim().slice(0, 1000);

  if (
    !['post', 'comment'].includes(targetType) ||
    !Number.isSafeInteger(targetId) ||
    targetId <= 0 ||
    !reason ||
    !REPORT_REASONS.has(reason) ||
    details.length < 5
  ) {
    res.status(400).json({ error: REPORT_ERROR });
    return;
  }

  const db = getDb();
  const target = db.prepare(
    'SELECT id, user_id, parent_id FROM posts WHERE id = ?'
  ).get(targetId) as { id: number; user_id: number; parent_id: number | null } | undefined;

  const isRequestedType =
    !!target &&
    (targetType === 'comment' ? target.parent_id !== null : target.parent_id === null);
  const viewer = req.user as any;
  const canViewTarget =
    !!target &&
    isRequestedType &&
    canViewPost(viewer, target.id) &&
    (target.parent_id === null || canViewPost(viewer, target.parent_id));

  // Use one response for missing, hidden, private, blocked, and mismatched-type
  // targets so the report endpoint cannot probe inaccessible content.
  if (!target || !canViewTarget) {
    res.status(404).json({ error: CONTENT_UNAVAILABLE });
    return;
  }

  if (target.user_id === req.user!.id) {
    res.status(400).json({ error: 'You cannot report your own content.' });
    return;
  }

  const inserted = db.transaction(() => {
    const duplicate = db.prepare(
      "SELECT 1 FROM reports WHERE reporter_id = ? AND post_id = ? AND status = 'open'"
    ).get(req.user!.id, target.id);
    if (duplicate) return false;

    db.prepare(
      'INSERT INTO reports (reporter_id, post_id, reason, report_details) VALUES (?, ?, ?, ?)'
    ).run(req.user!.id, target.id, reason, details);
    return true;
  })();

  if (!inserted) {
    res.status(409).json({ error: 'You have already reported this content.' });
    return;
  }

  res.status(201).json({ ok: true });
});

export default router;
