import { feedTimeSql, normalizedFeedTime } from '../feedTime.js';
import { RequestValidationError } from '../requestValidation.js';
import { Router } from 'express';
import { getDb } from '../database.js';
import { optionalAuth, requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPosts } from './posts.js';
import { fetchSource } from '../rssService.js';
import { getExternalFeed, getExternalFeedCursorPage, getExternalFeedPage, getPersonalExternalFeedStatus } from '../externalContentService.js';
import { logUsage } from '../usageEvents.js';
import { notMutedByViewerSql, postAuthorVisibilitySql } from '../visibility.js';
import { pageInteger } from '../pagination.js';
import { logSafeDiagnostic } from '../safeDiagnostics.js';
import { decodeFeedCursor, encodeFeedCursor } from '../feedCursor.js';

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

type ExternalItemType = 'all' | 'article' | 'podcast' | 'video';

function externalItemType(value: unknown): ExternalItemType {
  if (value === undefined || value === '') return 'all';
  if (typeof value !== 'string' || !['all', 'article', 'podcast', 'video'].includes(value)) {
    throw new RequestValidationError('itemType must be all, article, podcast, or video.');
  }
  return value as ExternalItemType;
}


// GET /api/feed?level=everyone|extended|friends|world&limit=50&cursor=...
// Explicit offset remains supported for older clients.
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  try {
    if (req.user) res.setHeader('Cache-Control', 'private, no-store');
    const limit = pageInteger(req.query.limit, 50, 1, 100);
    const offset = pageInteger(req.query.offset, 0, 0, 100000);
    const cursorMode = req.query.cursor !== undefined || req.query.offset === undefined;
    if (req.query.cursor !== undefined && req.query.offset !== undefined) {
      throw new RequestValidationError('Use cursor or offset, not both.');
    }
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
    const itemType = externalItemType(req.query.itemType);
    if (level !== 'world' && itemType !== 'all') {
      throw new RequestValidationError('itemType filters are available for My External Sources.');
    }
    const preference = req.user ? db.prepare(`
      SELECT world_home_injection, show_videos_in_feed FROM users WHERE id = ?
    `).get(req.user.id) as { world_home_injection: string; show_videos_in_feed: number } | undefined : undefined;

    // ─── World Feed mode ───
    if (level === 'world') {
      const personalExternalFeedStatus = getPersonalExternalFeedStatus(req.user?.id);
      const filter = itemType === 'all' ? undefined : itemType;
      const excludeVideos = itemType === 'all' && preference?.show_videos_in_feed === 0;
      const context = `world:${itemType}`;
      const cursor = cursorMode ? decodeFeedCursor(req.query.cursor, 'external', context) : null;
      const result = req.user
        ? cursorMode
          ? getExternalFeedCursorPage({ scope: 'personal', limit, cursor: cursor ?? undefined,
              itemType: filter, excludeVideos, userId: req.user.id })
          : getExternalFeedPage({ scope: 'personal', limit, offset, itemType: filter, excludeVideos, userId: req.user.id })
        : { items: [], pagination: cursorMode
            ? { limit, hasMore: false, nextKey: null }
            : { limit, offset, hasMore: false, nextOffset: null } };
      const nextKey = 'nextKey' in result.pagination ? result.pagination.nextKey : null;
      res.json({ posts: [], worldItems: result.items, items: result.items, level,
        itemType, showVideosInFeed: preference?.show_videos_in_feed !== 0,
        pagination: cursorMode ? {
          limit, hasMore: result.pagination.hasMore,
          nextCursor: nextKey ? encodeFeedCursor('external', context, nextKey) : null,
          nextOffset: null,
        } : result.pagination,
        personalExternalFeedStatus });
      return;
    }

    // ─── Native post modes ───
    let rows: any[];
    const context = `posts:${level}`;
    const cursor = cursorMode ? decodeFeedCursor(req.query.cursor, 'posts', context) : null;
    const cursorSql = cursor ? `AND (
      ${feedTimeSql('p.created_at')} < ?
      OR (${feedTimeSql('p.created_at')} = ? AND p.id < ?)
    )` : '';
    const cursorParams = cursor ? [cursor.time, cursor.time, cursor.id] : [];
    const pageSql = cursorMode ? 'LIMIT ?' : 'LIMIT ? OFFSET ?';
    const pageParams = cursorMode ? [limit + 1] : [limit + 1, offset];

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
          AND ${postVisibility.sql} AND ${notMuted.sql} ${cursorSql}
        ORDER BY ${feedTimeSql('p.created_at')} DESC, p.id DESC ${pageSql}
      `).all(req.user.id, req.user.id, ...(level === 'extended' ? [req.user.id] : []),
        ...postVisibility.params, ...notMuted.params, ...cursorParams, ...pageParams);
    } else if (level === 'everyone' && req.user) {
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.is_verified = 1
          AND ${postVisibility.sql}
          AND ${notMuted.sql} ${cursorSql}
        ORDER BY ${feedTimeSql('p.created_at')} DESC, p.id DESC ${pageSql}
      `).all(...postVisibility.params, ...notMuted.params, ...cursorParams, ...pageParams);
    } else {
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.is_verified = 1
          AND ${postVisibility.sql} ${cursorSql}
        ORDER BY ${feedTimeSql('p.created_at')} DESC, p.id DESC ${pageSql}
      `).all(...postVisibility.params, ...cursorParams, ...pageParams);
    }

    const hasMore = rows.length > limit && (cursorMode || offset + limit <= 100000);
    const pageRows = rows.slice(0, limit);
    const posts = enrichPosts(pageRows, req.user as any).map(post => ({ ...post, type: 'post' }));
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last
      ? encodeFeedCursor('posts', context, { time: normalizedFeedTime(db, last.created_at), id: last.id })
      : null;
    let worldItems: any[] = [];
    const personalExternalFeedStatus = getPersonalExternalFeedStatus(req.user?.id);

    if (req.user && offset === 0 && !cursor) {
      const worldPreference = preference?.world_home_injection || 'world_home_few';
      const worldLimit = worldInjectionLimit(posts.length, worldPreference);
      if (worldLimit > 0 && personalExternalFeedStatus === 'ready') {
        worldItems = getExternalFeed({ scope: 'personal', limit: worldLimit, offset: 0,
          excludeVideos: preference?.show_videos_in_feed === 0, userId: req.user.id });
      }
    }

    // World is a separate recommendation module, never part of native offsets.
    res.json({ posts, worldItems, items: posts, level, worldPlacement: 'separate', personalExternalFeedStatus,
      showVideosInFeed: preference?.show_videos_in_feed !== 0,
      pagination: cursorMode
        ? { limit, hasMore, nextCursor, nextOffset: null }
        : { limit, offset, hasMore, nextCursor, nextOffset: hasMore ? offset + posts.length : null } });
  } catch (err: any) {
    if (err instanceof RequestValidationError) { res.status(400).json({ error: err.message }); return; }
    logSafeDiagnostic({ subsystem: 'feed', severity: 'error', code: 'FEED_LOAD_FAILED' });
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

    // Determine sources before responding so we can report the count
    const sources: any[] = isAdmin
      ? db.prepare(`
          SELECT id FROM external_sources
          WHERE is_active = 1 AND tombstoned_at IS NULL AND (
            (provider='rss' AND source_kind='rss') OR
            (provider='youtube' AND source_kind='youtube_channel')
          )
          ORDER BY last_fetch_attempt_at ASC NULLS FIRST, id LIMIT 20
        `).all() as any[]
      : db.prepare(`
          SELECT s.id FROM external_sources s
          JOIN user_external_source_subscriptions sub ON sub.source_id = s.id
          WHERE sub.user_id = ? AND s.is_active = 1 AND s.tombstoned_at IS NULL
            AND ((s.provider='rss' AND s.source_kind='rss') OR
                 (s.provider='youtube' AND s.source_kind='youtube_channel'))
            AND NOT EXISTS (
              SELECT 1 FROM user_external_source_blocks block
              WHERE block.user_id = ? AND block.source_id = s.id
            )
          ORDER BY s.last_fetch_attempt_at ASC NULLS FIRST, s.id LIMIT 5
        `).all(userId, userId) as any[];

    if (!isAdmin && sources.length === 0) {
      res.json({ ok: true, started: false, sourcesChecked: 0,
        personalExternalFeedStatus: getPersonalExternalFeedStatus(userId) });
      return;
    }

    // A user with no eligible sources receives the source-state result above;
    // cooldown applies only when a refresh could actually start.
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
        if (errors.length) {
          logSafeDiagnostic({
            subsystem: 'feed', severity: 'warn', code: 'RSS_BATCH_COMPLETED_WITH_ERRORS',
            context: { errorCount: errors.length, itemsInserted: totalNew, sourcesChecked: sources.length },
          });
        }
        console.log(`[feed] Replenish: ${sources.length} sources, ${totalNew} new items`);
      } catch {
        logSafeDiagnostic({ subsystem: 'feed', severity: 'error', code: 'FEED_REPLENISH_FAILED' });
      } finally {
        replenishInFlight.delete(userId);
      }
    });
  } catch {
    logSafeDiagnostic({ subsystem: 'feed', severity: 'error', code: 'FEED_REPLENISH_FAILED' });
    res.status(500).json({ error: 'Could not replenish feed.' });
  }
});

export default router;
