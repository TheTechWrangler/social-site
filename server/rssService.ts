import { feedTimeSql } from './feedTime.js';
import { downloadFeed, parseFeedXml, validateRssUrl, RssFetchError } from './rssNetwork.js';
import { createRefreshCoordinator, RefreshBusyError } from './rssRefresh.js';
import { getDb } from './database.js';
import { notMutedByViewerSql, userVisibilitySql } from './visibility.js';
import { boundedInteger } from './pagination.js';

const refresh = createRefreshCoordinator();

export interface RssSource {
  id: number; name: string; url: string; homepage_url: string;
  category: string; is_active: number; last_fetched_at: string | null; last_fetch_attempt_at: string | null; last_fetch_error: string | null;
}

export interface FetchResult {
  sourceId: number;
  sourceName: string;
  category: string;
  itemsFound: number;
  itemsInserted: number;
  duplicatesSkipped: number;
  error: string | null;
}

// ─── Sanitize ───

function sanitize(text: string, maxLen = 2000): string {
  return text
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function sanitizeUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  try { return validateRssUrl(url).href; } catch { return ''; }
}

function firstSanitizedUrl(...urls: unknown[]): string {
  for (const url of urls) {
    const safe = sanitizeUrl(url);
    if (safe) return safe;
  }
  return '';
}

// ─── Source CRUD ───

export function getSources(): RssSource[] {
  return getDb().prepare('SELECT * FROM rss_sources ORDER BY name').all() as RssSource[];
}

export function addSource(name: string, url: string, homepageUrl: string, category: string): RssSource {
  const r = getDb().prepare(
    'INSERT INTO rss_sources (name, url, homepage_url, category) VALUES (?, ?, ?, ?)'
  ).run(name, validateRssUrl(url).href, sanitizeUrl(homepageUrl), category || 'general');
  return getDb().prepare('SELECT * FROM rss_sources WHERE id = ?').get(r.lastInsertRowid) as RssSource;
}

export interface RssSourceUpdate {
  name?: string;
  url?: string;
  homepageUrl?: string;
  category?: string;
  isActive?: boolean;
}

export function updateSource(id: number, updates: RssSourceUpdate): RssSource | null {
  const fields: string[] = [];
  const vals: Array<string | number> = [];

  // Every SQL identifier below is a server-owned literal. Request keys are
  // validated at the route and can never be interpolated into this statement.
  if (updates.name !== undefined) { fields.push('name = ?'); vals.push(updates.name); }
  if (updates.url !== undefined) { fields.push('url = ?'); vals.push(validateRssUrl(updates.url).href); }
  if (updates.homepageUrl !== undefined) { fields.push('homepage_url = ?'); vals.push(sanitizeUrl(updates.homepageUrl)); }
  if (updates.category !== undefined) { fields.push('category = ?'); vals.push(updates.category); }
  if (updates.isActive !== undefined) { fields.push('is_active = ?'); vals.push(updates.isActive ? 1 : 0); }
  if (fields.length === 0) return null;
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  const result = getDb().prepare(`UPDATE rss_sources SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  if (result.changes !== 1) return null;
  return getDb().prepare('SELECT * FROM rss_sources WHERE id = ?').get(id) as RssSource | null;
}

// ─── Fetch & Store ───

export async function fetchSource(sourceId: number): Promise<FetchResult> {
  const source = getDb().prepare('SELECT url FROM rss_sources WHERE id = ?').get(sourceId) as { url: string } | undefined;
  if (!source) return { sourceId, sourceName: '', category: '', itemsFound: 0, itemsInserted: 0, duplicatesSkipped: 0, error: 'Source not found' };
  // A corrected URL must not reuse a previous destination's cached outcome.
  try { return await refresh(`${sourceId}:${source.url}`, () => fetchSourceNow(sourceId)); }
  catch (error) {
    return { sourceId, sourceName: '', category: '', itemsFound: 0, itemsInserted: 0, duplicatesSkipped: 0,
      error: error instanceof RefreshBusyError ? error.message : 'Feed refresh failed.' };
  }
}

export function persistFetchedFeed(db: ReturnType<typeof getDb>, source: RssSource, feed: any) {
  return db.transaction(() => {
    let inserted = 0, dupes = 0, itemsFound = 0;

    const current = db.prepare('SELECT url FROM rss_sources WHERE id = ?').get(source.id) as { url: string } | undefined;
    if (current?.url !== source.url) throw new RssFetchError('Feed configuration changed during refresh; retry.');
    itemsFound = feed.items?.length || 0;

    const insert = db.prepare(`
      INSERT OR IGNORE INTO rss_items (source_id, external_guid, title, summary, content_snippet, link_url, author, image_url, published_at, item_type, enclosure_url, enclosure_type, duration_text, episode_image_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of feed.items || []) {
      const guid = item.guid || item.link || '';
      if (!guid) continue;

      const feedImageUrl = firstSanitizedUrl((feed as any).image?.url, (feed as any).image, (feed as any).itunes?.image);
      const title = sanitize(item.title || '', 500);
      const summary = sanitize(item.contentSnippet || item.summary || '', 1000);
      const contentSnippet = item.content ? sanitize(stripHtml(item.content), 2000) : '';
      const author = sanitize(item.creator || item.author || '', 200);
      const imageUrl = firstSanitizedUrl((item as any).image?.url, (item as any).image, (item as any).itunes?.image, item.enclosure?.url, feedImageUrl);
      const timestamp = Date.parse(item.pubDate || '');
      const publishedAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : new Date(0).toISOString();

      // Podcast detection: enclosure with audio MIME, or iTunes duration
      const encUrl = sanitizeUrl((item.enclosure?.url as string) || '');
      const encType = (item.enclosure?.type as string) || '';
      const itunesDuration = (item as any).itunes?.duration || '';
      const itunesImage = sanitizeUrl((item as any).itunes?.image || '');
      const isPodcast = encType.startsWith('audio/') || !!itunesDuration || (source.category || '').toLowerCase().includes('podcast');
      const itemType = isPodcast ? 'podcast' : 'article';
      const podcastImage = itunesImage || feedImageUrl;

      const r = insert.run(source.id, guid, title, summary, contentSnippet, sanitizeUrl(item.link || ''), author, imageUrl, publishedAt,
        itemType, encUrl, encType, itunesDuration, podcastImage);
      if (r.changes > 0) inserted++; else dupes++;
    }

    db.prepare("UPDATE rss_sources SET last_fetched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(source.id);
    db.prepare("UPDATE rss_sources SET last_fetch_attempt_at = datetime('now'), last_fetch_error = NULL WHERE id = ?").run(source.id);

    return { inserted, dupes, itemsFound };
  }).immediate();
}

async function fetchSourceNow(sourceId: number): Promise<FetchResult> {
  const db = getDb();
  const source = db.prepare('SELECT * FROM rss_sources WHERE id = ?').get(sourceId) as RssSource | undefined;
  if (!source) return { sourceId, sourceName: '', category: '', itemsFound: 0, itemsInserted: 0, duplicatesSkipped: 0, error: 'Source not found' };

  let inserted = 0;
  let dupes = 0;
  let itemsFound = 0;
  let error: string | null = null;

  try {
    const feed = await parseFeedXml(await downloadFeed(source.url));
    ({ inserted, dupes, itemsFound } = persistFetchedFeed(db, source, feed));
  } catch (err: any) {
    inserted = 0; dupes = 0;
    error = err instanceof RssFetchError ? err.message : 'Feed refresh failed.';
  }

  if (error) db.prepare("UPDATE rss_sources SET last_fetch_attempt_at = datetime('now'), last_fetch_error = ? WHERE id = ? AND url = ?").run(error, sourceId, source.url);
  return { sourceId, sourceName: source.name, category: source.category, itemsFound, itemsInserted: inserted, duplicatesSkipped: dupes, error };
}

let allInFlight: Promise<FetchResult[]> | null = null;
export function fetchAllSources(): Promise<FetchResult[]> {
  if (allInFlight) return allInFlight;
  allInFlight = (async () => {
    const sources = getDb().prepare("SELECT id FROM rss_sources WHERE is_active = 1 ORDER BY last_fetch_attempt_at ASC NULLS FIRST, id LIMIT 20").all() as { id: number }[];
    const results: FetchResult[] = new Array(sources.length);
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (index < sources.length) {
        const current = index++;
        results[current] = await fetchSource(sources[current].id);
      }
    }));
    return results;
  })().finally(() => { allInFlight = null; });
  return allInFlight;
}

// ─── World Feed Query ───

export function getWorldFeed(params: { sourceId?: number; category?: string; itemType?: string; limit?: number; offset?: number; userId?: number }) {
  const limit = boundedInteger(params.limit, 50, 1, 100);
  const offset = boundedInteger(params.offset, 0, 0, 100000);
  // Public discussion counts must use the same author policy as its comments.
  const viewer = params.userId ? { id: params.userId, role: 'user' } : null;
  const author = userVisibilitySql(viewer, 'cu', 'public-context');
  const notMuted = notMutedByViewerSql(viewer, 'cu');
  const commentCount = `(SELECT COUNT(*) FROM rss_item_comments c
    JOIN users cu ON cu.id = c.user_id
    WHERE c.rss_item_id = ri.id AND c.is_hidden = 0
      AND ${author.sql} AND ${notMuted.sql})`;

  // Per-source cap prevents one prolific source from dominating the feed.
  // Only applied when not filtering to a specific source or category.
  const applyPerSourceCap = !params.sourceId && !params.category;
  const perSourceCap = 8;

  let whereClause = 'WHERE rs.is_active = 1';
  const vals: any[] = [];

  if (params.sourceId) { whereClause += ' AND ri.source_id = ?'; vals.push(params.sourceId); }
  if (params.category) { whereClause += ' AND rs.category = ?'; vals.push(params.category); }
  if (params.itemType && (params.itemType === 'podcast' || params.itemType === 'article')) { whereClause += ' AND ri.item_type = ?'; vals.push(params.itemType); }
  if (params.userId) {
    whereClause += ' AND ri.source_id NOT IN (SELECT source_id FROM user_rss_source_blocks WHERE user_id = ?)';
    vals.push(params.userId);
  }

  let sql: string;
  if (applyPerSourceCap) {
    sql = `
      WITH ranked AS (
        SELECT ri.*, rs.name as source_name, rs.homepage_url as source_url, rs.category as source_category,
          ROW_NUMBER() OVER (PARTITION BY ri.source_id ORDER BY ${feedTimeSql('ri.published_at')} DESC, ri.id DESC) as rn
        FROM rss_items ri JOIN rss_sources rs ON ri.source_id = rs.id
        ${whereClause}
      )
      , page AS (SELECT * FROM ranked WHERE rn <= ? ORDER BY ${feedTimeSql('published_at')} DESC, id DESC LIMIT ? OFFSET ?)
      SELECT ri.*, ${commentCount} AS comment_count FROM page ri ORDER BY ${feedTimeSql('ri.published_at')} DESC, ri.id DESC
    `;
    vals.push(perSourceCap, limit, offset);
  } else {
    sql = `
      WITH page AS (SELECT ri.*, rs.name as source_name, rs.homepage_url as source_url, rs.category as source_category
      FROM rss_items ri JOIN rss_sources rs ON ri.source_id = rs.id
      ${whereClause}
      ORDER BY ${feedTimeSql('ri.published_at')} DESC, ri.id DESC LIMIT ? OFFSET ?)
      SELECT ri.*, ${commentCount} AS comment_count FROM page ri
      ORDER BY ${feedTimeSql('ri.published_at')} DESC, ri.id DESC
    `;
    vals.push(limit, offset);
  }

  vals.push(...author.params, ...notMuted.params);
  const items = getDb().prepare(sql).all(...vals) as any[];
  return items.map(i => ({
    id: i.id,
    type: 'world_item',
    item_type: i.item_type || 'article',
    source_id: i.source_id,
    source_name: i.source_name,
    category: i.source_category,
    content_snippet: i.content_snippet,
    link_url: i.link_url,
    image_url: i.image_url,
    enclosure_url: i.enclosure_url || '',
    enclosure_type: i.enclosure_type || '',
    duration_text: i.duration_text || '',
    episode_image_url: i.episode_image_url || '',
    published_at: i.published_at,
    comment_count: i.comment_count || 0,
    sourceId: i.source_id,
    sourceName: i.source_name,
    sourceUrl: i.source_url,
    sourceCategory: i.source_category,
    itemType: i.item_type || 'article',
    enclosureUrl: i.enclosure_url || '',
    enclosureType: i.enclosure_type || '',
    durationText: i.duration_text || '',
    episodeImageUrl: i.episode_image_url || '',
    title: i.title,
    summary: i.summary,
    contentSnippet: i.content_snippet,
    linkUrl: i.link_url,
    author: i.author,
    imageUrl: i.image_url,
    publishedAt: i.published_at,
  }));
}

// ─── User Source Blocks ───

export function getWorldFeedPage(params: Parameters<typeof getWorldFeed>[0]) {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const items = getWorldFeed({ ...params, limit, offset });
  const hasMore = items.length === limit && offset + limit <= 100000 &&
    getWorldFeed({ ...params, limit: 1, offset: offset + limit }).length > 0;
  return { items, pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null } };
}

export function getBlockedSourceIds(userId: number): number[] {
  return (getDb().prepare('SELECT source_id FROM user_rss_source_blocks WHERE user_id = ?').all(userId) as any[])
    .map(r => r.source_id);
}

export function blockSource(userId: number, sourceId: number): number {
  return getDb().prepare('INSERT OR IGNORE INTO user_rss_source_blocks (user_id, source_id) VALUES (?, ?)').run(userId, sourceId).changes;
}

export function unblockSource(userId: number, sourceId: number): number {
  return getDb().prepare('DELETE FROM user_rss_source_blocks WHERE user_id = ? AND source_id = ?').run(userId, sourceId).changes;
}
