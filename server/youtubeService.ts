import Parser from 'rss-parser';
import type Database from 'better-sqlite3';
import { downloadFeed, RSS_LIMITS, RssFetchError, type RssNetworkDependencies } from './rssNetwork.js';
import {
  isYouTubeChannelId,
  isYouTubeVideoId,
  parseYouTubeChannelLocator,
  youtubeChannelFeedUrl,
  youtubeChannelHomepageUrl,
  youtubeThumbnailUrl,
  youtubeWatchUrl,
} from '../shared/youtube.js';

export interface NormalizedYouTubeEntry {
  videoId: string;
  title: string;
  description: string;
  channelName: string;
  publishedAt: string;
  providerUpdatedAt: string | null;
}

export interface NormalizedYouTubeFeed {
  channelId: string;
  channelName: string;
  entries: NormalizedYouTubeEntry[];
}

export interface YouTubeProbe {
  channelId: string;
  feedUrl: string;
  homepageUrl: string;
  feed: NormalizedYouTubeFeed;
}

export interface YouTubeSource {
  id: number;
  name: string;
  fetch_url: string;
  homepage_url: string;
  category: string;
  is_active: number;
  tombstoned_at: string | null;
  provider_source_id: string;
}

export interface YouTubeFetchResult {
  sourceId: number;
  sourceName: string;
  category: string;
  itemsFound: number;
  itemsInserted: number;
  duplicatesSkipped: number;
  error: string | null;
}

function sanitizeText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function mediaDescription(item: any): string {
  const value = item?.mediaGroup?.['media:description'];
  return sanitizeText(Array.isArray(value) ? value[0] : value, 1000);
}

function normalizedTimestamp(value: unknown, required: boolean): string | null {
  const time = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(time)) {
    if (required) throw new RssFetchError('YouTube feed entry has an invalid publication time.');
    return null;
  }
  return new Date(time).toISOString();
}

function feedChannelId(feed: any): string | null {
  const declared = feed?.youtubeChannelId;
  if (isYouTubeChannelId(declared)) return declared;

  // YouTube currently emits the 22-character channel suffix in the feed-level
  // yt:channelId while retaining the full stable ID in its canonical channel
  // link. Never manufacture the missing prefix: recover a separately validated
  // full ID from that link, then require the declared suffix to corroborate it.
  const canonical = typeof feed?.link === 'string'
    ? parseYouTubeChannelLocator(feed.link)
    : null;
  if (!canonical || typeof declared !== 'string' || declared !== canonical.slice(2)) return null;
  return canonical;
}

export function validateYouTubeFeedDestination(url: URL, expectedChannelId: string): void {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!isYouTubeChannelId(expectedChannelId)
    || url.protocol !== 'https:'
    || host !== 'www.youtube.com'
    || url.username || url.password || url.port || url.hash
    || url.pathname !== '/feeds/videos.xml'
    || url.searchParams.size !== 1
    || url.searchParams.get('channel_id') !== expectedChannelId) {
    throw new RssFetchError('YouTube feed destination is not approved.');
  }
}

export async function parseYouTubeAtom(body: string, expectedChannelId: string): Promise<NormalizedYouTubeFeed> {
  if (Buffer.byteLength(body) > RSS_LIMITS.bytes || /<!DOCTYPE|<!ENTITY/i.test(body)) {
    throw new RssFetchError('YouTube feed XML exceeds supported limits.');
  }
  let feed: any;
  try {
    feed = await new Parser({
      customFields: {
        feed: [['yt:channelId', 'youtubeChannelId']],
        item: [
          ['yt:videoId', 'youtubeVideoId'],
          ['yt:channelId', 'youtubeChannelId'],
          ['updated', 'providerUpdatedAt'],
          ['media:group', 'mediaGroup'],
        ],
      },
    } as any).parseString(body);
  } catch {
    throw new RssFetchError('YouTube response is not valid Atom XML.');
  }

  const channelId = feedChannelId(feed);
  if (!isYouTubeChannelId(expectedChannelId) || channelId !== expectedChannelId) {
    throw new RssFetchError('YouTube feed identity does not match the configured channel.');
  }
  if (!Array.isArray(feed.items) || feed.items.length > 500) {
    throw new RssFetchError('YouTube feed item count is invalid.');
  }
  const channelName = sanitizeText(feed.title, 200);
  const entries = feed.items.map((item: any): NormalizedYouTubeEntry => {
    const videoId = item.youtubeVideoId;
    if (!isYouTubeVideoId(videoId) || item.youtubeChannelId !== expectedChannelId) {
      throw new RssFetchError('YouTube feed entry identity is invalid.');
    }
    return {
      videoId,
      title: sanitizeText(item.title, 500) || 'YouTube video',
      description: mediaDescription(item),
      channelName,
      publishedAt: normalizedTimestamp(item.isoDate || item.pubDate, true)!,
      providerUpdatedAt: normalizedTimestamp(item.providerUpdatedAt, false),
    };
  });
  return { channelId, channelName, entries };
}

export async function downloadYouTubeChannelFeed(
  channelId: string,
  dependencies: RssNetworkDependencies = {},
): Promise<NormalizedYouTubeFeed> {
  if (!isYouTubeChannelId(channelId)) throw new RssFetchError('Invalid YouTube channel ID.');
  const endpoint = youtubeChannelFeedUrl(channelId);
  const body = await downloadFeed(endpoint, {
    ...dependencies,
    validateDestination: url => validateYouTubeFeedDestination(url, channelId),
  });
  return parseYouTubeAtom(body, channelId);
}

export async function probeYouTubeChannel(
  locator: string,
  dependencies: RssNetworkDependencies = {},
): Promise<YouTubeProbe> {
  const channelId = parseYouTubeChannelLocator(locator);
  if (!channelId) throw new RssFetchError('Enter a YouTube channel ID or canonical channel URL.');
  const feed = await downloadYouTubeChannelFeed(channelId, dependencies);
  return {
    channelId,
    feedUrl: youtubeChannelFeedUrl(channelId),
    homepageUrl: youtubeChannelHomepageUrl(channelId),
    feed,
  };
}

export function persistYouTubeFeed(
  db: Database.Database,
  source: YouTubeSource,
  feed: NormalizedYouTubeFeed,
): { inserted: number; dupes: number; itemsFound: number } {
  return db.transaction(() => {
    const current = db.prepare(`
      SELECT name, fetch_url, homepage_url, category, is_active, tombstoned_at, provider_source_id
      FROM external_sources
      WHERE id = ? AND provider = 'youtube' AND source_kind = 'youtube_channel'
        AND tombstoned_at IS NULL
    `).get(source.id) as Omit<YouTubeSource, 'id'> | undefined;
    if (!current
      || current.fetch_url !== source.fetch_url
      || current.name !== source.name
      || current.homepage_url !== source.homepage_url
      || current.category !== source.category
      || current.is_active !== source.is_active
      || current.tombstoned_at !== source.tombstoned_at
      || current.provider_source_id !== source.provider_source_id
      || feed.channelId !== source.provider_source_id) {
      throw new RssFetchError('Feed configuration changed during refresh; retry.');
    }

    const findItem = db.prepare(`
      SELECT id FROM external_items WHERE provider = 'youtube' AND provider_item_id = ?
    `);
    const insertItem = db.prepare(`
      INSERT INTO external_items (
        provider, provider_item_id, item_kind, title, summary, content_snippet,
        author_name, canonical_url, image_url, media_provider, video_id,
        published_at, provider_updated_at, last_confirmed_at, updated_at
      ) VALUES ('youtube', ?, 'video', ?, ?, ?, ?, ?, ?, 'youtube', ?, ?, ?, datetime('now'), datetime('now'))
    `);
    const updateItem = db.prepare(`
      UPDATE external_items SET item_kind='video', title=?, summary=?, content_snippet=?,
        author_name=?, canonical_url=?, image_url=?, media_provider='youtube', video_id=?,
        published_at=?, provider_updated_at=?, last_confirmed_at=datetime('now'), updated_at=datetime('now')
      WHERE id=? AND provider='youtube'
    `);
    const findMembership = db.prepare(`
      SELECT item_id FROM external_source_items WHERE source_id=? AND source_entry_id=?
    `);
    const insertMembership = db.prepare(`
      INSERT INTO external_source_items(source_id,item_id,source_entry_id,source_added_at)
      VALUES (?,?,?,?)
    `);
    const touchMembership = db.prepare(`
      UPDATE external_source_items SET last_seen_at=datetime('now')
      WHERE source_id=? AND item_id=? AND source_entry_id=?
    `);

    let inserted = 0;
    let dupes = 0;
    for (const entry of feed.entries) {
      const canonicalUrl = youtubeWatchUrl(entry.videoId);
      const thumbnailUrl = youtubeThumbnailUrl(entry.videoId);
      const existing = findItem.get(entry.videoId) as { id: number } | undefined;
      let itemId: number;
      if (existing) {
        itemId = existing.id;
        updateItem.run(
          entry.title, entry.description, entry.description, entry.channelName,
          canonicalUrl, thumbnailUrl, entry.videoId, entry.publishedAt,
          entry.providerUpdatedAt, itemId,
        );
        dupes += 1;
      } else {
        const result = insertItem.run(
          entry.videoId, entry.title, entry.description, entry.description,
          entry.channelName, canonicalUrl, thumbnailUrl, entry.videoId,
          entry.publishedAt, entry.providerUpdatedAt,
        );
        itemId = Number(result.lastInsertRowid);
        inserted += 1;
      }

      const membership = findMembership.get(source.id, entry.videoId) as { item_id: number } | undefined;
      if (membership && membership.item_id !== itemId) {
        throw new RssFetchError('YouTube source membership conflicts with global video identity.');
      }
      if (membership) touchMembership.run(source.id, itemId, entry.videoId);
      else insertMembership.run(source.id, itemId, entry.videoId, entry.publishedAt);
    }

    db.prepare(`
      UPDATE external_sources
      SET last_fetched_at=datetime('now'), last_fetch_attempt_at=datetime('now'),
        last_failure_code=NULL, last_failure_detail=NULL, updated_at=datetime('now')
      WHERE id=?
    `).run(source.id);
    return { inserted, dupes, itemsFound: feed.entries.length };
  }).immediate();
}

export function createYouTubeSourceFromProbe(
  db: Database.Database,
  probe: YouTubeProbe,
  proposedName: string,
  proposedCategory: string,
): { sourceId: number; created: boolean } {
  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id, name, fetch_url, homepage_url, category, is_active, tombstoned_at, provider_source_id
      FROM external_sources
      WHERE provider='youtube' AND source_kind='youtube_channel' AND provider_source_id=?
    `).get(probe.channelId) as YouTubeSource | undefined;
    if (existing?.tombstoned_at) throw new RssFetchError('This approved channel is unavailable for reuse.');
    if (existing) {
      persistYouTubeFeed(db, existing, probe.feed);
      return { sourceId: existing.id, created: false };
    }

    const name = sanitizeText(proposedName, 120) || sanitizeText(probe.feed.channelName, 120) || 'YouTube channel';
    const category = sanitizeText(proposedCategory, 80) || 'general';
    const result = db.prepare(`
      INSERT INTO external_sources (
        provider, source_kind, provider_source_id, name, fetch_url, homepage_url, category
      ) VALUES ('youtube','youtube_channel',?,?,?,?,?)
    `).run(probe.channelId, name, probe.feedUrl, probe.homepageUrl, category);
    const source = db.prepare(`
      SELECT id, name, fetch_url, homepage_url, category, is_active, tombstoned_at, provider_source_id
      FROM external_sources WHERE id=?
    `).get(result.lastInsertRowid) as YouTubeSource;
    persistYouTubeFeed(db, source, probe.feed);
    return { sourceId: source.id, created: true };
  }).immediate();
}

export async function fetchYouTubeSourceNow(db: Database.Database, sourceId: number): Promise<YouTubeFetchResult> {
  const source = db.prepare(`
    SELECT id, name, fetch_url, homepage_url, category, is_active, tombstoned_at, provider_source_id
    FROM external_sources
    WHERE id=? AND provider='youtube' AND source_kind='youtube_channel' AND tombstoned_at IS NULL
  `).get(sourceId) as YouTubeSource | undefined;
  if (!source) return { sourceId, sourceName: '', category: '', itemsFound: 0, itemsInserted: 0, duplicatesSkipped: 0, error: 'Source not found' };

  try {
    const feed = await downloadYouTubeChannelFeed(source.provider_source_id);
    const result = persistYouTubeFeed(db, source, feed);
    return {
      sourceId,
      sourceName: source.name,
      category: source.category,
      itemsFound: result.itemsFound,
      itemsInserted: result.inserted,
      duplicatesSkipped: result.dupes,
      error: null,
    };
  } catch (error) {
    const message = error instanceof RssFetchError ? error.message : 'YouTube channel refresh failed.';
    db.prepare(`
      UPDATE external_sources SET last_fetch_attempt_at=datetime('now'),
        last_failure_code='YOUTUBE_FETCH_FAILED', last_failure_detail=?, updated_at=datetime('now')
      WHERE id=? AND provider='youtube' AND source_kind='youtube_channel'
        AND provider_source_id=? AND fetch_url=? AND name=? AND homepage_url=?
        AND category=? AND is_active=? AND tombstoned_at IS ?
    `).run(
      message.slice(0, 500), source.id, source.provider_source_id, source.fetch_url,
      source.name, source.homepage_url, source.category, source.is_active, source.tombstoned_at,
    );
    return {
      sourceId,
      sourceName: source.name,
      category: source.category,
      itemsFound: 0,
      itemsInserted: 0,
      duplicatesSkipped: 0,
      error: message,
    };
  }
}
