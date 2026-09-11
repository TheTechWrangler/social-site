import { feedTimeSql } from '../feedTime.js';
import { RequestValidationError } from '../requestValidation.js';
import { Router } from 'express';
import { getDb } from '../database.js';
import { optionalAuth, requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPosts } from './posts.js';
import { getWorldFeed, getWorldFeedPage, fetchSource } from '../rssService.js';
import { logUsage } from '../usageEvents.js';
import { notMutedByViewerSql, postAuthorVisibilitySql } from '../visibility.js';
import { pageInteger } from '../pagination.js';

const router = Router();

// In-memory set of user IDs with a replenish already in flight.
// Prevents the same user from stacking multiple concurrent fetches.
const replenishInFlight = new Set<number>();

function worldInjectionLimit(nativeCount: number, preference: string): number {
  if (preference === 'world_home_off') return 0;
  if (preference === 'world_home_balanced') {
    if (nativeCount === 0) return 4;
    return Math.min(20, Math.max(2, Math.ceil(nativeCount / 4)));
  }
  if (nativeCount === 0) return 2;
  if (nativeCount < 8) return 1;
  return Math.min(10, Math.max(1, Math.ceil(nativeCount / 9)));
}


// GET /api/feed?level=everyone|extended|friends|world&limit=50&offset=0
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  try {
    const limit = pageInteger(req.query.limit, 50, 1, 100);
    const offset = pageInteger(req.query.offset, 0, 0, 100000);
    const db = getDb();
    const postVisibility = postAuthorVisibilitySql(req.user as any, 'p', 'u');
    const notMuted = notMutedByViewerSql(req.user as any, 'u');

    // Map old exposure values to new levels
    const levelMap: Record<string, string> = {
      friends_only: 'friends', mixed: 'extended', everyone: 'everyone',
      friends: 'friends', extended: 'extended', world: 'world',
    };
    let level = levelMap[(req.query.level as string) || ''] || '';

    if (!['everyone', 'extended', 'friends', 'world'].includes(level)) {
      if (req.user) {
        const u = db.prepare('SELECT feed_exposure FROM users WHERE id = ?').get(req.user.id) as any;
        const raw = u?.feed_exposure || 'extended';
        level = levelMap[raw] || 'extended';
      } else {
        level = 'extended';
      }
    }

    // ─── World Feed mode ───
    if (level === 'world') {
      const { items, pagination } = getWorldFeedPage({ limit, offset, userId: req.user?.id });
      res.json({ posts: [], worldItems: items, items, level, pagination });
      return;
    }

    // ─── Native post modes ───
    let rows: any[];

    if ((level === 'friends' || level === 'extended') && req.user) {
      const extended = level === 'extended' ? `OR (u.is_verified = 1 AND p.user_id IN (
        SELECT following_id FROM follows WHERE status = 'accepted' AND follower_id IN (
          SELECT following_id FROM follows WHERE follower_id = ? AND status = 'accepted'
        )))` : '';
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0
          AND (p.user_id = ? OR p.user_id IN (
            SELECT following_id FROM follows WHERE follower_id = ? AND status = 'accepted'
          ) ${extended})
          AND ${postVisibility.sql} AND ${notMuted.sql}
        ORDER BY ${feedTimeSql('p.created_at')} DESC, p.id DESC LIMIT ? OFFSET ?
      `).all(req.user.id, req.user.id, ...(level === 'extended' ? [req.user.id] : []),
        ...postVisibility.params, ...notMuted.params, limit + 1, offset);
    } else if (level === 'everyone' && req.user) {
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.is_verified = 1
          AND ${postVisibility.sql}
          AND ${notMuted.sql}
        ORDER BY ${feedTimeSql('p.created_at')} DESC, p.id DESC LIMIT ? OFFSET ?
      `).all(...postVisibility.params, ...notMuted.params, limit + 1, offset);
    } else {
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.is_verified = 1
          AND ${postVisibility.sql}
        ORDER BY ${feedTimeSql('p.created_at')} DESC, p.id DESC LIMIT ? OFFSET ?
      `).all(...postVisibility.params, limit + 1, offset);
    }

    const hasMore = rows.length > limit && offset + limit <= 100000;
    const posts = enrichPosts(rows.slice(0, limit), req.user as any).map(post => ({ ...post, type: 'post' }));
    let worldItems: any[] = [];

    if (req.user && offset === 0) {
      const prefRow = db.prepare('SELECT world_home_injection FROM users WHERE id = ?').get(req.user.id) as any;
      const preference = prefRow?.world_home_injection || 'world_home_few';
      const worldLimit = worldInjectionLimit(posts.length, preference);
      if (worldLimit > 0) {
        worldItems = getWorldFeed({ limit: worldLimit, offset: 0, userId: req.user.id });
      }
    }

    // World is a separate recommendation module, never part of native offsets.
    res.json({ posts, worldItems, items: posts, level, worldPlacement: 'separate',
      pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + posts.length : null } });
  } catch (err: any) {
    if (err instanceof RequestValidationError) { res.status(400).json({ error: err.message }); return; }
    console.error('[feed] Load feed error:', err.message);
    res.status(500).json({ error: 'Could not load feed.' });
  }
});

// POST /api/feed/replenish — User-triggered feed refresh, once per rolling 24 hours.
// Responds immediately and runs fetches asynchronously so slow sources never
// block the HTTP response. Admins bypass the cooldown and get all active sources.
router.post('/replenish', requireAuth, requireVerified, (req: AuthRequest, res) => {
  try {
    const db = getDb();
    const userId = req.user!.id;
    const isAdmin = req.user!.role === 'admin';

    // Cooldown check (non-admin only)
    if (!isAdmin) {
      const row = db.prepare('SELECT last_feed_refresh_at FROM users WHERE id = ?').get(userId) as any;
      if (row?.last_feed_refresh_at) {
        const lastMs = new Date(row.last_feed_refresh_at + 'Z').getTime();
        const nextMs = lastMs + 24 * 60 * 60 * 1000;
        if (Date.now() < nextMs) {
          const nextAt = new Date(nextMs).toISOString();
          res.status(429).json({ error: 'Daily replenish already used.', nextAvailableAt: nextAt });
          return;
        }
      }
    }

    // Per-user in-flight guard (non-admin; admins use fetch-all instead)
    if (replenishInFlight.has(userId)) {
      res.status(429).json({ error: 'A replenish is already running for your account.' });
      return;
    }

    // Determine sources before responding so we can report the count
    const sources: any[] = isAdmin
      ? db.prepare("SELECT id FROM rss_sources WHERE is_active = 1 ORDER BY last_fetch_attempt_at ASC NULLS FIRST, id LIMIT 20").all() as any[]
      : db.prepare("SELECT id FROM rss_sources WHERE is_active = 1 ORDER BY last_fetch_attempt_at ASC NULLS FIRST LIMIT 5").all() as any[];

    // Mark cooldown and in-flight immediately — before the async work starts —
    // so a second request during the fetch window is correctly rejected.
    if (!isAdmin) {
      db.prepare("UPDATE users SET last_feed_refresh_at = datetime('now') WHERE id = ?").run(userId);
    }
    replenishInFlight.add(userId);

    // Respond immediately; actual fetching happens asynchronously
    logUsage({ eventType: 'rss_replenished', userId, featureArea: 'world', metadata: { sourcesChecked: sources.length } });
    res.json({ ok: true, started: true, sourcesChecked: sources.length });

    // Fire-and-forget: run fetches after the response is sent
    setImmediate(async () => {
      try {
        let totalNew = 0;
        const errors: string[] = [];
        for (let start = 0; start < sources.length; start += 4) {
          for (const r of await Promise.all(sources.slice(start, start + 4).map(s => fetchSource(s.id)))) {
          totalNew += r.itemsInserted;
          if (r.error) errors.push(`Source ${r.sourceId}: ${r.error}`);
          }
        }
        if (errors.length) console.warn('[feed] Replenish errors:', errors.join('; '));
        console.log(`[feed] Replenish (user ${userId}): ${sources.length} sources, ${totalNew} new items`);
      } catch (err: any) {
        console.error('[feed] Replenish async error:', err.message);
      } finally {
        replenishInFlight.delete(userId);
      }
    });
  } catch (err: any) {
    console.error('[feed] Replenish error:', err.message);
    res.status(500).json({ error: 'Could not replenish feed.' });
  }
});

export default router;
