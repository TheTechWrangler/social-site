import { feedTimeSql } from './feedTime.js';
import { getDb } from './database.js';
import { boundedInteger } from './pagination.js';
import { notMutedByViewerSql, userVisibilitySql } from './visibility.js';
import type {
  ExternalSourceCatalogDto,
  ExternalSubscriptionResult,
  PersonalExternalFeedStatus,
  PublicExternalSourceDto,
} from '../shared/externalContent.js';

export type ExternalFeedScope = 'world' | 'personal';

function availability(row: { is_active: number; tombstoned_at: string | null }): PublicExternalSourceDto['availability'] {
  if (row.tombstoned_at) return 'removed';
  return row.is_active ? 'active' : 'disabled';
}

export function getPublicSourceCatalog(userId?: number): ExternalSourceCatalogDto {
  const params: number[] = [];
  let viewerColumns = '0 AS subscribed, 0 AS blocked';
  let where = 'WHERE s.is_active = 1 AND s.tombstoned_at IS NULL';
  if (userId) {
    viewerColumns = `
      EXISTS(SELECT 1 FROM user_external_source_subscriptions sub WHERE sub.user_id = ? AND sub.source_id = s.id) AS subscribed,
      EXISTS(SELECT 1 FROM user_external_source_blocks block WHERE block.user_id = ? AND block.source_id = s.id) AS blocked
    `;
    params.push(userId, userId);
    where = `WHERE (s.is_active = 1 AND s.tombstoned_at IS NULL)
      OR EXISTS(SELECT 1 FROM user_external_source_subscriptions own WHERE own.user_id = ? AND own.source_id = s.id)`;
    params.push(userId);
  }
  const rows = getDb().prepare(`
    SELECT s.id, s.name, s.category, s.homepage_url, s.source_kind,
      s.is_active, s.tombstoned_at, ${viewerColumns}
    FROM external_sources s ${where}
    ORDER BY s.name, s.id
  `).all(...params) as any[];
  const sources = rows.map(row => ({
    id: row.id,
    name: row.name,
    category: row.category,
    homepageUrl: row.homepage_url,
    sourceKind: row.source_kind,
    availability: availability(row),
    viewer: userId ? { subscribed: !!row.subscribed, blocked: !!row.blocked } : null,
  }));
  const categories = [...new Set(sources.filter(source => source.availability === 'active').map(source => source.category))];
  return { sources, categories };
}

export function getBlockedSourceIds(userId: number): number[] {
  return (getDb().prepare('SELECT source_id FROM user_external_source_blocks WHERE user_id = ?').all(userId) as any[])
    .map(row => row.source_id);
}

export function getBlockedSources(userId: number): PublicExternalSourceDto[] {
  const rows = getDb().prepare(`
    SELECT s.id, s.name, s.category, s.homepage_url, s.source_kind,
      s.is_active, s.tombstoned_at,
      EXISTS(SELECT 1 FROM user_external_source_subscriptions sub WHERE sub.user_id = ? AND sub.source_id = s.id) AS subscribed
    FROM external_sources s
    JOIN user_external_source_blocks block ON block.source_id = s.id AND block.user_id = ?
    ORDER BY s.name, s.id
  `).all(userId, userId) as any[];
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    category: row.category,
    homepageUrl: row.homepage_url,
    sourceKind: row.source_kind,
    availability: availability(row),
    viewer: { subscribed: !!row.subscribed, blocked: true },
  }));
}

export function blockSource(userId: number, sourceId: number): number {
  return getDb().prepare('INSERT OR IGNORE INTO user_external_source_blocks(user_id, source_id) VALUES (?, ?)')
    .run(userId, sourceId).changes;
}

export function unblockSource(userId: number, sourceId: number): number {
  return getDb().prepare('DELETE FROM user_external_source_blocks WHERE user_id = ? AND source_id = ?')
    .run(userId, sourceId).changes;
}

export type SubscribeResult =
  | { ok: true; value: ExternalSubscriptionResult }
  | { ok: false; reason: 'unavailable' | 'blocked' };

export function subscribeToSource(userId: number, sourceId: number): SubscribeResult {
  return getDb().transaction(() => {
    const source = getDb().prepare(`
      SELECT id FROM external_sources
      WHERE id = ? AND is_active = 1 AND tombstoned_at IS NULL
    `).get(sourceId);
    if (!source) return { ok: false as const, reason: 'unavailable' as const };
    const blocked = !!getDb().prepare(`
      SELECT 1 FROM user_external_source_blocks WHERE user_id = ? AND source_id = ?
    `).get(userId, sourceId);
    if (blocked) return { ok: false as const, reason: 'blocked' as const };
    getDb().prepare(`
      INSERT OR IGNORE INTO user_external_source_subscriptions(user_id, source_id) VALUES (?, ?)
    `).run(userId, sourceId);
    return { ok: true as const, value: { sourceId, subscribed: true, blocked: false } };
  }).immediate();
}

export function unsubscribeFromSource(userId: number, sourceId: number): ExternalSubscriptionResult {
  return getDb().transaction(() => {
    getDb().prepare(`
      DELETE FROM user_external_source_subscriptions WHERE user_id = ? AND source_id = ?
    `).run(userId, sourceId);
    const blocked = !!getDb().prepare(`
      SELECT 1 FROM user_external_source_blocks WHERE user_id = ? AND source_id = ?
    `).get(userId, sourceId);
    return { sourceId, subscribed: false, blocked };
  }).immediate();
}

export function getPersonalExternalFeedStatus(userId?: number): PersonalExternalFeedStatus {
  if (!userId) return 'authentication_required';
  const subscribed = Number((getDb().prepare(`
    SELECT COUNT(*) AS count FROM user_external_source_subscriptions WHERE user_id = ?
  `).get(userId) as any).count);
  if (subscribed === 0) return 'no_subscriptions';
  const eligible = Number((getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM user_external_source_subscriptions sub
    JOIN external_sources s ON s.id = sub.source_id
    WHERE sub.user_id = ? AND s.is_active = 1 AND s.tombstoned_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM user_external_source_blocks block
        WHERE block.user_id = ? AND block.source_id = s.id
      )
  `).get(userId, userId) as any).count);
  return eligible > 0 ? 'ready' : 'no_active_subscriptions';
}

export interface ExternalFeedParams {
  scope?: ExternalFeedScope;
  sourceId?: number;
  category?: string;
  itemType?: string;
  limit?: number;
  offset?: number;
  userId?: number;
}

export function getExternalFeed(params: ExternalFeedParams) {
  const scope = params.scope ?? 'world';
  if (scope === 'personal' && !params.userId) return [];
  const limit = boundedInteger(params.limit, 50, 1, 100);
  const offset = boundedInteger(params.offset, 0, 0, 100000);
  const viewer = params.userId ? { id: params.userId, role: 'user' } : null;
  const author = userVisibilitySql(viewer, 'cu', 'public-context');
  const notMuted = notMutedByViewerSql(viewer, 'cu');
  const commentCount = `(SELECT COUNT(*) FROM external_item_comments c
    JOIN users cu ON cu.id = c.user_id
    WHERE c.external_item_id = ei.id AND c.is_hidden = 0
      AND ${author.sql} AND ${notMuted.sql})`;

  const applyPerSourceCap = !params.sourceId && !params.category;
  const whereValues: Array<string | number> = [];
  let where = 'WHERE es.is_active = 1 AND es.tombstoned_at IS NULL';
  if (params.sourceId) { where += ' AND esi.source_id = ?'; whereValues.push(params.sourceId); }
  if (params.category) { where += ' AND es.category = ?'; whereValues.push(params.category); }
  if (params.itemType && ['article', 'podcast', 'video'].includes(params.itemType)) {
    where += ' AND ei.item_kind = ?'; whereValues.push(params.itemType);
  }
  if (params.userId) {
    where += ` AND NOT EXISTS (
      SELECT 1 FROM user_external_source_blocks block
      WHERE block.user_id = ? AND block.source_id = esi.source_id
    )`;
    whereValues.push(params.userId);
  }
  if (scope === 'personal') {
    where += ` AND EXISTS (
      SELECT 1 FROM user_external_source_subscriptions sub
      WHERE sub.user_id = ? AND sub.source_id = esi.source_id
    )`;
    whereValues.push(params.userId!);
  }

  let sql: string;
  const values = [...whereValues];
  if (applyPerSourceCap) {
    sql = `
      WITH ranked AS (
        SELECT ei.*, esi.source_id, es.name AS source_name,
          es.homepage_url AS source_url, es.category AS source_category,
          es.source_kind,
          ROW_NUMBER() OVER (
            PARTITION BY esi.source_id
            ORDER BY ${feedTimeSql('ei.published_at')} DESC, ei.id DESC
          ) AS rn
        FROM external_items ei
        JOIN external_source_items esi ON esi.item_id = ei.id
        JOIN external_sources es ON es.id = esi.source_id
        ${where}
      ), page AS (
        SELECT * FROM ranked WHERE rn <= ?
        ORDER BY ${feedTimeSql('published_at')} DESC, id DESC LIMIT ? OFFSET ?
      )
      SELECT ei.*, ${commentCount} AS comment_count FROM page ei
      ORDER BY ${feedTimeSql('ei.published_at')} DESC, ei.id DESC
    `;
    values.push(8, limit, offset, ...author.params, ...notMuted.params);
  } else {
    sql = `
      WITH page AS (
        SELECT ei.*, esi.source_id, es.name AS source_name,
          es.homepage_url AS source_url, es.category AS source_category,
          es.source_kind
        FROM external_items ei
        JOIN external_source_items esi ON esi.item_id = ei.id
        JOIN external_sources es ON es.id = esi.source_id
        ${where}
        ORDER BY ${feedTimeSql('ei.published_at')} DESC, ei.id DESC LIMIT ? OFFSET ?
      )
      SELECT ei.*, ${commentCount} AS comment_count FROM page ei
      ORDER BY ${feedTimeSql('ei.published_at')} DESC, ei.id DESC
    `;
    values.push(limit, offset, ...author.params, ...notMuted.params);
  }

  return (getDb().prepare(sql).all(...values) as any[]).map(item => ({
    id: item.id,
    type: 'world_item',
    item_type: item.item_kind,
    source_id: item.source_id,
    source_name: item.source_name,
    category: item.source_category,
    content_snippet: item.content_snippet,
    link_url: item.canonical_url,
    image_url: item.image_url,
    enclosure_url: item.enclosure_url,
    enclosure_type: item.enclosure_type,
    duration_text: item.duration_text,
    episode_image_url: item.episode_image_url,
    published_at: item.published_at,
    comment_count: item.comment_count || 0,
    sourceId: item.source_id,
    sourceName: item.source_name,
    sourceUrl: item.source_url,
    sourceCategory: item.source_category,
    sourceKind: item.source_kind,
    itemType: item.item_kind,
    enclosureUrl: item.enclosure_url,
    enclosureType: item.enclosure_type,
    durationText: item.duration_text,
    episodeImageUrl: item.episode_image_url,
    title: item.title,
    summary: item.summary,
    contentSnippet: item.content_snippet,
    linkUrl: item.canonical_url,
    author: item.author_name,
    imageUrl: item.image_url,
    mediaProvider: item.media_provider,
    videoId: item.video_id,
    publishedAt: item.published_at,
  }));
}

export function getExternalFeedPage(params: ExternalFeedParams) {
  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;
  const items = getExternalFeed({ ...params, limit, offset });
  const hasMore = items.length === limit && offset + limit <= 100000
    && getExternalFeed({ ...params, limit: 1, offset: offset + limit }).length > 0;
  return { items, pagination: { limit, offset, hasMore, nextOffset: hasMore ? offset + limit : null } };
}
