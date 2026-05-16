import { Router } from 'express';
import { getDb } from '../database.js';
import { optionalAuth, requireAuth, requireVerified, type AuthRequest } from '../middleware.js';
import { enrichPost } from './posts.js';
import { getWorldFeed, fetchSource } from '../rssService.js';
import { logUsage } from '../usageEvents.js';

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

function itemTime(item: any): string {
  return item.type === 'world_item' ? (item.publishedAt || item.published_at || '') : (item.createdAt || '');
}

// GET /api/feed?level=everyone|extended|friends|world&limit=50&offset=0
router.get('/', optionalAuth, (req: AuthRequest, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Number(req.query.offset) || 0;
    const db = getDb();

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
      const items = getWorldFeed({ limit, offset, userId: req.user?.id });
      res.json({ posts: [], worldItems: items, items: items, level });
      return;
    }

    // ─── Native post modes ───
    let rows: any[];

    if ((level === 'friends' || level === 'extended') && req.user) {
      const friendLimit = level === 'friends' ? limit : Math.ceil(limit * 0.75);
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0
          AND (p.user_id = ? OR p.user_id IN (SELECT following_id FROM follows WHERE follower_id = ?))
          AND p.user_id NOT IN (SELECT blocked_user_id FROM user_relationship_blocks WHERE blocker_user_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM user_relationship_blocks b
            WHERE b.relationship_type = 'block'
              AND ((b.blocker_user_id = p.user_id AND b.blocked_user_id = ?) OR (b.blocker_user_id = ? AND b.blocked_user_id = p.user_id))
          )
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, friendLimit, offset);

      if (level === 'extended') {
        const extLimit = limit - rows.length;
        if (extLimit > 0) {
          const extRows = db.prepare(`
            SELECT DISTINCT p.*, u.username, u.display_name, u.avatar_url
            FROM posts p JOIN users u ON p.user_id = u.id
            WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0 AND u.is_verified = 1
              AND u.profile_visibility = 'public'
              AND p.user_id != ?
              AND p.user_id NOT IN (SELECT following_id FROM follows WHERE follower_id = ?)
              AND p.user_id NOT IN (SELECT blocked_user_id FROM user_relationship_blocks WHERE blocker_user_id = ?)
              AND NOT EXISTS (
                SELECT 1 FROM user_relationship_blocks b
                WHERE b.relationship_type = 'block'
                  AND ((b.blocker_user_id = p.user_id AND b.blocked_user_id = ?) OR (b.blocker_user_id = ? AND b.blocked_user_id = p.user_id))
              )
              AND p.user_id IN (
                SELECT following_id FROM follows WHERE follower_id IN (SELECT following_id FROM follows WHERE follower_id = ?)
              )
            ORDER BY p.created_at DESC LIMIT ?
          `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, req.user.id, extLimit);
          rows = [...rows, ...extRows].sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));
        }
      }
    } else if (level === 'everyone' && req.user) {
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0 AND u.is_verified = 1 AND u.profile_visibility = 'public'
          AND p.user_id NOT IN (SELECT blocked_user_id FROM user_relationship_blocks WHERE blocker_user_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM user_relationship_blocks b
            WHERE b.relationship_type = 'block'
              AND ((b.blocker_user_id = p.user_id AND b.blocked_user_id = ?) OR (b.blocker_user_id = ? AND b.blocked_user_id = p.user_id))
          )
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(req.user.id, req.user.id, req.user.id, limit, offset);
    } else {
      rows = db.prepare(`
        SELECT p.*, u.username, u.display_name, u.avatar_url
        FROM posts p JOIN users u ON p.user_id = u.id
        WHERE p.parent_id IS NULL AND p.hidden = 0 AND u.banned = 0 AND u.is_verified = 1 AND u.profile_visibility = 'public'
        ORDER BY p.created_at DESC LIMIT ? OFFSET ?
      `).all(limit, offset);
    }

    const posts = rows.map((r: any) => ({ ...enrichPost(r, req.user?.id), type: 'post' }));
    let worldItems: any[] = [];

    if (req.user) {
      const prefRow = db.prepare('SELECT world_home_injection FROM users WHERE id = ?').get(req.user.id) as any;
      const preference = prefRow?.world_home_injection || 'world_home_few';
      const worldLimit = worldInjectionLimit(posts.length, preference);
      if (worldLimit > 0) {
        worldItems = getWorldFeed({ limit: worldLimit, offset: 0, userId: req.user.id });
      }
    }

    const items = [...posts, ...worldItems]
      .sort((a: any, b: any) => itemTime(b).localeCompare(itemTime(a)));
    res.json({ posts, worldItems, items, level });
  } catch (err: any) {
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
    if (!isAdmin && replenishInFlight.has(userId)) {
      res.status(429).json({ error: 'A replenish is already running for your account.' });
      return;
    }

    // Determine sources before responding so we can report the count
    const sources: any[] = isAdmin
      ? db.prepare("SELECT id FROM rss_sources WHERE is_active = 1").all() as any[]
      : db.prepare("SELECT id FROM rss_sources WHERE is_active = 1 ORDER BY last_fetched_at ASC NULLS FIRST LIMIT 5").all() as any[];

    // Mark cooldown and in-flight immediately — before the async work starts —
    // so a second request during the fetch window is correctly rejected.
    if (!isAdmin) {
      db.prepare("UPDATE users SET last_feed_refresh_at = datetime('now') WHERE id = ?").run(userId);
      replenishInFlight.add(userId);
    }

    // Respond immediately; actual fetching happens asynchronously
    logUsage({ eventType: 'rss_replenished', userId, featureArea: 'world', metadata: { sourcesChecked: sources.length } });
    res.json({ ok: true, started: true, sourcesChecked: sources.length });

    // Fire-and-forget: run fetches after the response is sent
    setImmediate(async () => {
      try {
        let totalNew = 0;
        const errors: string[] = [];
        for (const s of sources) {
          const r = await fetchSource(s.id);
          totalNew += r.itemsInserted;
          if (r.error) errors.push(`${r.sourceName}: ${r.error}`);
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
