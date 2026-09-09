import { Router } from 'express';
import { requireAuth, requireAdmin, optionalAuth, requireVerified } from '../middleware.js';
import { getWorldFeed, getSources, getBlockedSourceIds, blockSource, unblockSource, addSource, updateSource, fetchSource, fetchAllSources } from '../rssService.js';
import { boundedInteger } from '../pagination.js';
import { logAuthEvent } from '../authEvents.js';

const publicRouter = Router();
const adminRouter = Router();

// ─── In-memory fetch-all job state ───
// Prevents multiple overlapping fetch-all jobs; surfaces basic status to admin.
interface FetchAllState {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  lastResultSummary: { sourcesChecked: number; totalNew: number; errors: number } | null;
  lastError: string | null;
}
const fetchAllState: FetchAllState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  lastResultSummary: null,
  lastError: null,
};

async function runFetchAllInBackground(): Promise<void> {
  if (fetchAllState.running) return; // already in progress — skip
  fetchAllState.running = true;
  fetchAllState.startedAt = new Date().toISOString();
  fetchAllState.finishedAt = null;
  fetchAllState.lastError = null;
  try {
    const results = await fetchAllSources();
    const totalNew = results.reduce((s, r) => s + r.itemsInserted, 0);
    const errors = results.filter(r => r.error).length;
    fetchAllState.lastResultSummary = { sourcesChecked: results.length, totalNew, errors };
    if (errors) {
      const errList = results.filter(r => r.error).map(r => `${r.sourceName}: ${r.error}`).join('; ');
      console.warn('[rss] fetch-all errors:', errList);
    }
    console.log(`[rss] fetch-all complete: ${results.length} sources, ${totalNew} new items, ${errors} errors`);
  } catch (err: any) {
    fetchAllState.lastError = err.message || 'Unknown error';
    console.error('[rss] fetch-all background error:', err.message);
  } finally {
    fetchAllState.running = false;
    fetchAllState.finishedAt = new Date().toISOString();
  }
}

function logRssError(context: string, err: unknown): void {
  console.error(`[rss] ${context}:`, err instanceof Error ? err.message : String(err));
}

// ─── Public World Feed ───

publicRouter.get('/', optionalAuth, (req, res) => {
  try {
    const sourceId = req.query.sourceId ? Number(req.query.sourceId) : undefined;
    const category = req.query.category as string | undefined;
    const limit = boundedInteger(req.query.limit, 50, 1, 100);
    const offset = boundedInteger(req.query.offset, 0, 0, 100000);
    const userId = (req as any).user?.id;
    const items = getWorldFeed({ sourceId, category, limit, offset, userId });
    res.json({ items });
  } catch (err: any) {
    logRssError('Load world feed error', err);
    res.status(500).json({ error: 'Could not load world feed.' });
  }
});

publicRouter.get('/sources', optionalAuth, (req, res) => {
  try {
    const sources = getSources().filter(s => s.is_active);
    const categories = [...new Set(sources.map(s => s.category))];
    const userId = (req as any).user?.id;
    const blockedIds = userId ? getBlockedSourceIds(userId) : [];
    const sourcesWithBlock = sources.map(s => ({
      ...s,
      isBlocked: blockedIds.includes(s.id),
    }));
    res.json({ sources: sourcesWithBlock, categories });
  } catch (err: any) {
    logRssError('Load sources error', err);
    res.status(500).json({ error: 'Could not load RSS sources.' });
  }
});

// ─── User Source Blocking ───

// GET /api/world-feed/blocked-sources
publicRouter.get('/blocked-sources', requireAuth, requireVerified, (req, res) => {
  try {
    const user = (req as any).user;
    const blockedIds = getBlockedSourceIds(user.id);
    const allSources = getSources();
    const blocked = allSources.filter(s => blockedIds.includes(s.id)).map(s => ({
      id: s.id, name: s.name, category: s.category, homepage_url: s.homepage_url,
    }));
    res.json({ blocked });
  } catch (err: any) {
    logRssError('Load blocked sources error', err);
    res.status(500).json({ error: 'Could not load blocked sources.' });
  }
});

// POST /api/world-feed/sources/:sourceId/block
publicRouter.post('/sources/:sourceId/block', requireAuth, requireVerified, (req, res) => {
  try {
    const user = (req as any).user;
    blockSource(user.id, Number(req.params.sourceId));
    res.json({ ok: true, blocked: true });
  } catch (err: any) {
    logRssError('Block source error', err);
    res.status(500).json({ error: 'Could not block source.' });
  }
});

// DELETE /api/world-feed/sources/:sourceId/block
publicRouter.delete('/sources/:sourceId/block', requireAuth, requireVerified, (req, res) => {
  try {
    const user = (req as any).user;
    unblockSource(user.id, Number(req.params.sourceId));
    res.json({ ok: true, blocked: false });
  } catch (err: any) {
    logRssError('Unblock source error', err);
    res.status(500).json({ error: 'Could not unblock source.' });
  }
});

// ─── Admin RSS Management ───

adminRouter.get('/sources', requireAuth, requireAdmin, (_req, res) => {
  try {
    res.json({ sources: getSources() });
  } catch (err: any) {
    logRssError('Admin load sources error', err);
    res.status(500).json({ error: 'Could not load RSS sources.' });
  }
});

adminRouter.post('/sources', requireAuth, requireAdmin, (req, res) => {
  try {
    const { name, url, homepageUrl, category } = req.body;
    if (!name || !url) { res.status(400).json({ error: 'Name and URL required.' }); return; }
    const source = addSource(name, url, homepageUrl || '', category || 'general');
    const adminId = (req as any).user.id;
    logAuthEvent({ eventType: 'admin_rss_source_add', userId: adminId, adminActorId: adminId, meta: { sourceId: source.id, name } });
    res.status(201).json({ source });
  } catch (err: any) {
    logRssError('Admin add source error', err);
    res.status(500).json({ error: 'Could not add RSS source.' });
  }
});

adminRouter.patch('/sources/:id', requireAuth, requireAdmin, (req, res) => {
  try {
    const source = updateSource(Number(req.params.id), req.body);
    if (!source) { res.status(404).json({ error: 'Source not found.' }); return; }
    const adminId = (req as any).user.id;
    logAuthEvent({ eventType: 'admin_rss_source_update', userId: adminId, adminActorId: adminId, meta: { sourceId: source.id } });
    res.json({ source });
  } catch (err: any) {
    logRssError('Admin update source error', err);
    res.status(500).json({ error: 'Could not update RSS source.' });
  }
});

adminRouter.post('/sources/:id/fetch', requireAuth, requireAdmin, async (req, res) => {
  try {
    const sourceId = Number(req.params.id);
    const result = await fetchSource(sourceId);
    const adminId = (req as any).user.id;
    logAuthEvent({ eventType: 'admin_rss_source_fetch', userId: adminId, adminActorId: adminId, meta: { sourceId, itemsInserted: result.itemsInserted ?? 0 } });
    res.json(result);
  } catch (err: any) {
    logRssError('Admin fetch source error', err);
    res.status(500).json({ error: 'Could not fetch RSS source.' });
  }
});

// GET /admin/rss/fetch-all/status — poll background fetch-all job state
adminRouter.get('/fetch-all/status', requireAuth, requireAdmin, (_req, res) => {
  res.json({ ...fetchAllState });
});

// POST /admin/rss/fetch-all — start background fetch of all active sources.
// Returns immediately; use GET /fetch-all/status to follow progress.
adminRouter.post('/fetch-all', requireAuth, requireAdmin, (_req, res) => {
  if (fetchAllState.running) {
    res.json({ ok: true, started: false, running: true, message: 'A fetch is already in progress.', startedAt: fetchAllState.startedAt });
    return;
  }
  // Fire-and-forget — setImmediate yields the event loop so the response is sent first
  setImmediate(() => { runFetchAllInBackground().catch(() => {}); });
  res.json({ ok: true, started: true, message: 'RSS fetch started in background. Use the status endpoint to monitor progress.' });
});

export { publicRouter, adminRouter };
