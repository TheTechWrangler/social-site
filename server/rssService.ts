import Parser from 'rss-parser';
import { getDb } from './database.js';

const parser = new Parser({
  timeout: 10000,
  headers: { 'User-Agent': 'SocialSite/0.1 World Feed Reader' },
});

interface RssSource {
  id: number; name: string; url: string; homepage_url: string;
  category: string; is_active: number; last_fetched_at: string | null;
}

interface FetchResult {
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

/**
 * SSRF guard — returns true if the hostname/IP targets a private/loopback/
 * link-local range that the server should never fetch on behalf of users.
 *
 * Covers without DNS resolution (limitation noted below):
 *   localhost / *.local
 *   127.0.0.0/8  10.0.0.0/8  172.16.0.0/12  192.168.0.0/16
 *   169.254.0.0/16  0.0.0.0/8  100.64.0.0/10  198.18.0.0/15
 *   ::1  fc00::/7 (fc/fd)  fe80::/10
 *
 * DNS-rebinding limitation: a hostname that *resolves* to a private IP at
 * fetch time is not blocked here (no DNS lookup is performed — adding one
 * would require async code and a safe resolver). Mitigated by the fact that
 * only admin users can add sources.
 */
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // Strip IPv6 brackets e.g. [::1]
  const raw = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // Plain hostname checks
  if (raw === 'localhost') return true;
  if (raw === '') return true;
  if (raw.endsWith('.local')) return true;
  if (raw.endsWith('.localhost')) return true;
  if (raw.endsWith('.internal')) return true;

  // IPv6 loopback / ULA / link-local
  if (raw === '::1' || raw === '0:0:0:0:0:0:0:1') return true;
  if (raw.startsWith('fc') || raw.startsWith('fd')) return true; // fc00::/7 (ULA)
  if (raw.startsWith('fe80')) return true; // fe80::/10 (link-local)

  // IPv4 private/reserved ranges
  const ipv4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b, c] = [Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3])];
    if (a === 0) return true;                             // 0.0.0.0/8
    if (a === 10) return true;                            // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (shared)
    if (a === 127) return true;                           // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true;              // 169.254.0.0/16 (link-local)
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true;    // 192.0.0.0/24 (IANA special)
    if (a === 192 && b === 168) return true;              // 192.168.0.0/16
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
    if (a >= 240) return true;                            // 240.0.0.0/4 + broadcast
  }

  return false;
}

/** Only allow http:// and https:// URLs to public hosts. Returns '' for anything private/invalid. */
function sanitizeUrl(url: unknown): string {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (isPrivateHostname(parsed.hostname)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
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
  ).run(name, sanitizeUrl(url), sanitizeUrl(homepageUrl), category || 'general');
  return getDb().prepare('SELECT * FROM rss_sources WHERE id = ?').get(r.lastInsertRowid) as RssSource;
}

export function updateSource(id: number, updates: { name?: string; url?: string; homepage_url?: string; category?: string; is_active?: number }): RssSource | null {
  const fields: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) {
      fields.push(`${k} = ?`);
      vals.push(k === 'url' || k === 'homepage_url' ? sanitizeUrl(v) : v);
    }
  }
  if (fields.length === 0) return null;
  fields.push("updated_at = datetime('now')");
  vals.push(id);
  getDb().prepare(`UPDATE rss_sources SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
  return getDb().prepare('SELECT * FROM rss_sources WHERE id = ?').get(id) as RssSource | null;
}

// ─── Fetch & Store ───

export async function fetchSource(sourceId: number): Promise<FetchResult> {
  const db = getDb();
  const source = db.prepare('SELECT * FROM rss_sources WHERE id = ?').get(sourceId) as RssSource | undefined;
  if (!source) return { sourceId, sourceName: '', category: '', itemsFound: 0, itemsInserted: 0, duplicatesSkipped: 0, error: 'Source not found' };

  let inserted = 0;
  let dupes = 0;
  let itemsFound = 0;
  let error: string | null = null;

  try {
    const feed = await parser.parseURL(source.url);
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
      const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();

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

    db.prepare("UPDATE rss_sources SET last_fetched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(sourceId);
  } catch (err: any) {
    error = err.message || 'Unknown fetch error';
  }

  return { sourceId, sourceName: source.name, category: source.category, itemsFound, itemsInserted: inserted, duplicatesSkipped: dupes, error };
}

export async function fetchAllSources(): Promise<FetchResult[]> {
  const sources = getDb().prepare("SELECT * FROM rss_sources WHERE is_active = 1").all() as RssSource[];
  const results: FetchResult[] = [];
  for (const s of sources) {
    results.push(await fetchSource(s.id));
  }
  return results;
}

// ─── World Feed Query ───

export function getWorldFeed(params: { sourceId?: number; category?: string; itemType?: string; limit?: number; offset?: number; userId?: number }) {
  const limit = Math.min(params.limit || 50, 100);
  const offset = params.offset || 0;

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
          (SELECT COUNT(*) FROM rss_item_comments c WHERE c.rss_item_id = ri.id AND c.is_hidden = 0) as comment_count,
          ROW_NUMBER() OVER (PARTITION BY ri.source_id ORDER BY ri.published_at DESC) as rn
        FROM rss_items ri JOIN rss_sources rs ON ri.source_id = rs.id
        ${whereClause}
      )
      SELECT * FROM ranked WHERE rn <= ? ORDER BY published_at DESC LIMIT ? OFFSET ?
    `;
    vals.push(perSourceCap, limit, offset);
  } else {
    sql = `
      SELECT ri.*, rs.name as source_name, rs.homepage_url as source_url, rs.category as source_category,
        (SELECT COUNT(*) FROM rss_item_comments c WHERE c.rss_item_id = ri.id AND c.is_hidden = 0) as comment_count
      FROM rss_items ri JOIN rss_sources rs ON ri.source_id = rs.id
      ${whereClause}
      ORDER BY ri.published_at DESC LIMIT ? OFFSET ?
    `;
    vals.push(limit, offset);
  }

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

export function getBlockedSourceIds(userId: number): number[] {
  return (getDb().prepare('SELECT source_id FROM user_rss_source_blocks WHERE user_id = ?').all(userId) as any[])
    .map(r => r.source_id);
}

export function blockSource(userId: number, sourceId: number): void {
  getDb().prepare('INSERT OR IGNORE INTO user_rss_source_blocks (user_id, source_id) VALUES (?, ?)').run(userId, sourceId);
}

export function unblockSource(userId: number, sourceId: number): void {
  getDb().prepare('DELETE FROM user_rss_source_blocks WHERE user_id = ? AND source_id = ?').run(userId, sourceId);
}
