import { downloadFeed, parseFeedXml, validateRssUrl, RssFetchError } from './rssNetwork.js';
import { createRefreshCoordinator, RefreshBusyError } from './rssRefresh.js';
import { getDb } from './database.js';
export {
  blockSource,
  getBlockedSourceIds,
  getExternalFeed as getWorldFeed,
  getExternalFeedPage as getWorldFeedPage,
  unblockSource,
} from './externalContentService.js';

const refresh = createRefreshCoordinator();

export interface RssSource {
  id: number; name: string; url: string; homepage_url: string;
  category: string; is_active: number; tombstoned_at: string | null;
  last_fetched_at: string | null; last_fetch_attempt_at: string | null;
  last_fetch_error: string | null; last_failure_code: string | null;
  updated_at: string;
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
  return getDb().prepare(`
    SELECT id, name, fetch_url AS url, homepage_url, category, is_active,
      tombstoned_at, last_fetched_at, last_fetch_attempt_at,
      last_failure_detail AS last_fetch_error, last_failure_code, updated_at
    FROM external_sources
    WHERE provider = 'rss' AND source_kind = 'rss'
    ORDER BY name, id
  `).all() as RssSource[];
}

export function addSource(name: string, url: string, homepageUrl: string, category: string): RssSource {
  const r = getDb().prepare(`
    INSERT INTO external_sources
      (provider, source_kind, name, fetch_url, homepage_url, category)
    VALUES ('rss', 'rss', ?, ?, ?, ?)
  `).run(name, validateRssUrl(url).href, sanitizeUrl(homepageUrl), category || 'general');
  return getSources().find(source => source.id === Number(r.lastInsertRowid))!;
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
  if (updates.url !== undefined) { fields.push('fetch_url = ?'); vals.push(validateRssUrl(updates.url).href); }
  if (updates.homepageUrl !== undefined) { fields.push('homepage_url = ?'); vals.push(sanitizeUrl(updates.homepageUrl)); }
  if (updates.category !== undefined) { fields.push('category = ?'); vals.push(updates.category); }
  if (updates.isActive !== undefined) { fields.push('is_active = ?'); vals.push(updates.isActive ? 1 : 0); }
  if (fields.length === 0) return null;
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  const result = getDb().prepare(`
    UPDATE external_sources SET ${fields.join(', ')}
    WHERE id = ? AND provider = 'rss' AND source_kind = 'rss' AND tombstoned_at IS NULL
  `).run(...vals);
  if (result.changes !== 1) return null;
  return getSources().find(source => source.id === id) ?? null;
}

// ─── Fetch & Store ───

export async function fetchSource(sourceId: number): Promise<FetchResult> {
  const source = getDb().prepare(`
    SELECT fetch_url AS url FROM external_sources
    WHERE id = ? AND provider = 'rss' AND source_kind = 'rss' AND tombstoned_at IS NULL
  `).get(sourceId) as { url: string } | undefined;
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

    const current = db.prepare(`
      SELECT name, fetch_url AS url, homepage_url, category, is_active, tombstoned_at
      FROM external_sources
      WHERE id = ? AND provider = 'rss' AND source_kind = 'rss' AND tombstoned_at IS NULL
    `).get(source.id) as Pick<RssSource, 'name' | 'url' | 'homepage_url' | 'category' | 'is_active' | 'tombstoned_at'> | undefined;
    if (!current
      || current.url !== source.url
      || current.name !== source.name
      || current.homepage_url !== source.homepage_url
      || current.category !== source.category
      || current.is_active !== source.is_active
      || current.tombstoned_at !== source.tombstoned_at) {
      throw new RssFetchError('Feed configuration changed during refresh; retry.');
    }
    itemsFound = feed.items?.length || 0;

    const findMembership = db.prepare(`
      SELECT item_id FROM external_source_items WHERE source_id = ? AND source_entry_id = ?
    `);
    const insertItem = db.prepare(`
      INSERT INTO external_items (
        provider, provider_item_id, item_kind, title, summary, content_snippet,
        author_name, canonical_url, image_url, episode_image_url,
        enclosure_url, enclosure_type, duration_text, published_at,
        last_confirmed_at, updated_at
      ) VALUES ('rss', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    const insertMembership = db.prepare(`
      INSERT INTO external_source_items(source_id, item_id, source_entry_id)
      VALUES (?, ?, ?)
    `);

    for (const item of feed.items || []) {
      const guid = item.guid || item.link || '';
      if (!guid) continue;
      if (guid.length > 2048) continue;
      if (findMembership.get(source.id, guid)) { dupes++; continue; }

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

      const r = insertItem.run(itemType, title, summary, contentSnippet,
        author, sanitizeUrl(item.link || ''), imageUrl, podcastImage,
        encUrl, encType.slice(0, 200), String(itunesDuration).slice(0, 100), publishedAt);
      insertMembership.run(source.id, Number(r.lastInsertRowid), guid);
      inserted++;
    }

    db.prepare(`
      UPDATE external_sources
      SET last_fetched_at = datetime('now'), last_fetch_attempt_at = datetime('now'),
        last_failure_code = NULL, last_failure_detail = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(source.id);

    return { inserted, dupes, itemsFound };
  }).immediate();
}

async function fetchSourceNow(sourceId: number): Promise<FetchResult> {
  const db = getDb();
  const source = db.prepare(`
    SELECT id, name, fetch_url AS url, homepage_url, category, is_active,
      tombstoned_at, last_fetched_at, last_fetch_attempt_at,
      last_failure_detail AS last_fetch_error, last_failure_code, updated_at
    FROM external_sources
    WHERE id = ? AND provider = 'rss' AND source_kind = 'rss' AND tombstoned_at IS NULL
  `).get(sourceId) as RssSource | undefined;
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

  if (error) db.prepare(`
    UPDATE external_sources
    SET last_fetch_attempt_at = datetime('now'), last_failure_code = 'RSS_FETCH_FAILED',
      last_failure_detail = ?, updated_at = datetime('now')
    WHERE id = ? AND fetch_url = ? AND name = ? AND homepage_url = ?
      AND category = ? AND is_active = ? AND tombstoned_at IS ?
      AND provider = 'rss' AND source_kind = 'rss'
  `).run(error.slice(0, 500), sourceId, source.url, source.name, source.homepage_url,
    source.category, source.is_active, source.tombstoned_at);
  return { sourceId, sourceName: source.name, category: source.category, itemsFound, itemsInserted: inserted, duplicatesSkipped: dupes, error };
}

let allInFlight: Promise<FetchResult[]> | null = null;
export function fetchAllSources(): Promise<FetchResult[]> {
  if (allInFlight) return allInFlight;
  allInFlight = (async () => {
    const sources = getDb().prepare(`
      SELECT id FROM external_sources
      WHERE provider = 'rss' AND source_kind = 'rss'
        AND is_active = 1 AND tombstoned_at IS NULL
      ORDER BY last_fetch_attempt_at ASC NULLS FIRST, id LIMIT 20
    `).all() as { id: number }[];
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
