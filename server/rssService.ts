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

// ─── Source CRUD ───

export function getSources(): RssSource[] {
  return getDb().prepare('SELECT * FROM rss_sources ORDER BY name').all() as RssSource[];
}

export function addSource(name: string, url: string, homepageUrl: string, category: string): RssSource {
  const r = getDb().prepare(
    'INSERT INTO rss_sources (name, url, homepage_url, category) VALUES (?, ?, ?, ?)'
  ).run(name, url, homepageUrl, category || 'general');
  return getDb().prepare('SELECT * FROM rss_sources WHERE id = ?').get(r.lastInsertRowid) as RssSource;
}

export function updateSource(id: number, updates: { name?: string; url?: string; homepage_url?: string; category?: string; is_active?: number }): RssSource | null {
  const fields: string[] = [];
  const vals: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) { fields.push(`${k} = ?`); vals.push(v); }
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
  if (!source) return { sourceId, sourceName: '', itemsFound: 0, itemsInserted: 0, duplicatesSkipped: 0, error: 'Source not found' };

  let inserted = 0;
  let dupes = 0;
  let itemsFound = 0;
  let error: string | null = null;

  try {
    const feed = await parser.parseURL(source.url);
    itemsFound = feed.items?.length || 0;

    const insert = db.prepare(`
      INSERT OR IGNORE INTO rss_items (source_id, external_guid, title, summary, content_snippet, link_url, author, image_url, published_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const item of feed.items || []) {
      const guid = item.guid || item.link || '';
      if (!guid) continue;

      const title = sanitize(item.title || '', 500);
      const summary = sanitize(item.contentSnippet || item.summary || '', 1000);
      const contentSnippet = item.content ? sanitize(stripHtml(item.content), 2000) : '';
      const author = sanitize(item.creator || item.author || '', 200);
      const imageUrl = item.enclosure?.url || '';
      const publishedAt = item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString();

      const r = insert.run(source.id, guid, title, summary, contentSnippet, item.link || '', author, imageUrl, publishedAt);
      if (r.changes > 0) inserted++; else dupes++;
    }

    db.prepare("UPDATE rss_sources SET last_fetched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(sourceId);
  } catch (err: any) {
    error = err.message || 'Unknown fetch error';
  }

  return { sourceId, sourceName: source.name, itemsFound, itemsInserted: inserted, duplicatesSkipped: dupes, error };
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

export function getWorldFeed(params: { sourceId?: number; category?: string; limit?: number; offset?: number; userId?: number }) {
  const limit = Math.min(params.limit || 50, 100);
  const offset = params.offset || 0;
  let sql = `
    SELECT ri.*, rs.name as source_name, rs.homepage_url as source_url, rs.category as source_category
    FROM rss_items ri JOIN rss_sources rs ON ri.source_id = rs.id
    WHERE rs.is_active = 1
  `;
  const vals: any[] = [];

  if (params.sourceId) { sql += ' AND ri.source_id = ?'; vals.push(params.sourceId); }
  if (params.category) { sql += ' AND rs.category = ?'; vals.push(params.category); }

  // Exclude blocked sources for authenticated users
  if (params.userId) {
    sql += ' AND ri.source_id NOT IN (SELECT source_id FROM user_rss_source_blocks WHERE user_id = ?)';
    vals.push(params.userId);
  }

  sql += ' ORDER BY ri.published_at DESC LIMIT ? OFFSET ?';
  vals.push(limit, offset);

  const items = getDb().prepare(sql).all(...vals) as any[];
  return items.map(i => ({
    id: i.id,
    sourceId: i.source_id,
    sourceName: i.source_name,
    sourceUrl: i.source_url,
    sourceCategory: i.source_category,
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
