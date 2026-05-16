import { Router } from 'express';
import { requireAuth, requireAdmin, optionalAuth, requireVerified } from '../middleware.js';
import { getWorldFeed, getSources, getBlockedSourceIds, blockSource, unblockSource, addSource, updateSource, fetchSource, fetchAllSources } from '../rssService.js';

const publicRouter = Router();
const adminRouter = Router();

function logRssError(context: string, err: unknown): void {
  console.error(`[rss] ${context}:`, err instanceof Error ? err.message : String(err));
}

// ─── Public World Feed ───

publicRouter.get('/', optionalAuth, (req, res) => {
  try {
    const sourceId = req.query.sourceId ? Number(req.query.sourceId) : undefined;
    const category = req.query.category as string | undefined;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;
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
    res.json({ source });
  } catch (err: any) {
    logRssError('Admin update source error', err);
    res.status(500).json({ error: 'Could not update RSS source.' });
  }
});

adminRouter.post('/sources/:id/fetch', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await fetchSource(Number(req.params.id));
    res.json(result);
  } catch (err: any) {
    logRssError('Admin fetch source error', err);
    res.status(500).json({ error: 'Could not fetch RSS source.' });
  }
});

adminRouter.post('/fetch-all', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const results = await fetchAllSources();
    res.json(results);
  } catch (err: any) {
    logRssError('Admin fetch all sources error', err);
    res.status(500).json({ error: 'Could not fetch RSS sources.' });
  }
});

export { publicRouter, adminRouter };
