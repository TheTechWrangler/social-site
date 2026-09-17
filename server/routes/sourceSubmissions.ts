import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAdmin, requireAuth, requireVerified } from '../middleware.js';
import {
  RequestValidationError,
  enumField,
  positiveIntegerParam,
  stringField,
  validatedObjectBody,
  validationErrorMessage,
} from '../requestValidation.js';
import {
  approveSourceSubmission,
  createSourceSubmission,
  getAdminSourceSubmissions,
  getOwnSourceSubmissions,
  rejectSourceSubmission,
  type SubmissionKind,
} from '../sourceSubmissions.js';
import { createYouTubeSourceFromProbe, probeYouTubeChannel } from '../youtubeService.js';
import { getDb } from '../database.js';
import { logAuthEvent } from '../authEvents.js';
import { logSafeDiagnostic } from '../safeDiagnostics.js';

export const submissionPublicRouter = Router();
export const submissionAdminRouter = Router();

const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many feed suggestions. Please wait before trying again.' },
});
const adminProbeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many source validation requests. Please wait before trying again.' },
});

const SUBMISSION_FIELDS = ['sourceKind', 'locator', 'name', 'category', 'note'] as const;
const REVIEW_FIELDS = ['reason'] as const;
const YOUTUBE_FIELDS = ['locator', 'name', 'category'] as const;

function parseSubmission(value: unknown) {
  const body = validatedObjectBody(value, SUBMISSION_FIELDS);
  return {
    sourceKind: enumField(body, 'sourceKind', ['rss', 'youtube_channel'] as const, { required: true }) as SubmissionKind,
    locator: stringField(body, 'locator', { required: true, maxLength: 2048 })!,
    name: stringField(body, 'name', { maxLength: 120, allowEmpty: true }) ?? '',
    category: stringField(body, 'category', { maxLength: 80, allowEmpty: true }) ?? 'general',
    note: stringField(body, 'note', { maxLength: 500, allowEmpty: true }) ?? '',
  };
}

function safeFailure(res: any, error: unknown, fallback: string) {
  const message = validationErrorMessage(error);
  if (message) { res.status(400).json({ error: message }); return; }
  if (error instanceof Error && /Enter a |valid HTTP|Unsupported source/.test(error.message)) {
    res.status(400).json({ error: error.message }); return;
  }
  logSafeDiagnostic({ subsystem: 'rss', severity: 'warn', code: 'EXTERNAL_SOURCE_OPERATION_FAILED' });
  res.status(502).json({ error: fallback });
}

submissionPublicRouter.post('/source-submissions', submitLimiter, requireAuth, requireVerified, (req, res) => {
  try {
    const result = createSourceSubmission((req as any).user.id, parseSubmission(req.body));
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    safeFailure(res, error, 'Could not save this feed suggestion.');
  }
});

submissionPublicRouter.get('/source-submissions', requireAuth, requireVerified, (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    res.json({ submissions: getOwnSourceSubmissions((req as any).user.id) });
  } catch {
    logSafeDiagnostic({ subsystem: 'rss', severity: 'warn', code: 'EXTERNAL_SOURCE_OPERATION_FAILED' });
    res.status(500).json({ error: 'Could not load your feed suggestions.' });
  }
});

submissionAdminRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  next();
});

submissionAdminRouter.get('/source-submissions', requireAuth, requireAdmin, (req, res) => {
  try {
    const raw = req.query.status;
    if (raw !== undefined && (typeof raw !== 'string' || !['pending', 'approved', 'rejected'].includes(raw))) {
      throw new RequestValidationError('status must be pending, approved, or rejected.');
    }
    res.json({ submissions: getAdminSourceSubmissions(raw as any) });
  } catch (error) {
    safeFailure(res, error, 'Could not load source suggestions.');
  }
});

submissionAdminRouter.post('/source-submissions/:id/approve', adminProbeLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    validatedObjectBody(req.body, [], { allowEmpty: true });
    const id = positiveIntegerParam(req.params.id, 'submissionId');
    const submission = await approveSourceSubmission(id, (req as any).user.id);
    if (!submission) { res.status(409).json({ error: 'This suggestion is no longer pending.' }); return; }
    res.json({ submission });
  } catch (error) {
    safeFailure(res, error, 'Source validation failed. The suggestion remains pending.');
  }
});

submissionAdminRouter.post('/source-submissions/:id/reject', requireAuth, requireAdmin, (req, res) => {
  try {
    const id = positiveIntegerParam(req.params.id, 'submissionId');
    const body = validatedObjectBody(req.body, REVIEW_FIELDS, { allowEmpty: true });
    const reason = stringField(body, 'reason', { maxLength: 500, allowEmpty: true }) ?? '';
    const submission = rejectSourceSubmission(id, (req as any).user.id, reason);
    if (!submission) { res.status(409).json({ error: 'This suggestion is no longer pending.' }); return; }
    res.json({ submission });
  } catch (error) {
    safeFailure(res, error, 'Could not reject this source suggestion.');
  }
});

submissionAdminRouter.post('/youtube-sources', adminProbeLimiter, requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = validatedObjectBody(req.body, YOUTUBE_FIELDS);
    const locator = stringField(body, 'locator', { required: true, maxLength: 2048 })!;
    const name = stringField(body, 'name', { maxLength: 120, allowEmpty: true }) ?? '';
    const category = stringField(body, 'category', { maxLength: 80, allowEmpty: true }) ?? 'general';
    const probe = await probeYouTubeChannel(locator);
    const result = createYouTubeSourceFromProbe(getDb(), probe, name, category);
    const adminId = (req as any).user.id;
    logAuthEvent({ eventType: 'admin_rss_source_add', userId: adminId, adminActorId: adminId, meta: { sourceId: result.sourceId } });
    res.status(result.created ? 201 : 200).json({ sourceId: result.sourceId, created: result.created });
  } catch (error) {
    safeFailure(res, error, 'YouTube channel validation failed.');
  }
});
