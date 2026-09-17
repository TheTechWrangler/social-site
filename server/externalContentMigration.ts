import type Database from 'better-sqlite3';
import { applyMigration } from './migrations.js';

export const EXTERNAL_CONTENT_MIGRATION_ID = 'external-content-foundation-v1';
export const MAX_CONTINUITY_SUBSCRIPTIONS = 250_000;

const TARGET_TABLES = [
  'external_sources',
  'external_items',
  'external_source_items',
  'user_external_source_subscriptions',
  'user_external_source_blocks',
  'external_item_comments',
] as const;

function count(db: Database.Database, sql: string): number {
  return Number((db.prepare(sql).get() as { count: number }).count);
}

function requireZero(db: Database.Database, label: string, sql: string): void {
  if (count(db, sql) !== 0) throw new Error(`External content migration blocked: ${label}.`);
}

function requireEqual(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`External content migration validation failed: ${label}.`);
}

/** One-time, transactional cutover from the legacy RSS tables. */
export function migrateExternalContentFoundation(db: Database.Database): void {
  applyMigration(db, EXTERNAL_CONTENT_MIGRATION_ID, () => {
    const placeholders = TARGET_TABLES.map(() => '?').join(',');
    const existingTargets = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) LIMIT 1`,
    ).get(...TARGET_TABLES);
    if (existingTargets) {
      throw new Error('External content migration blocked: target tables already exist without a ledger entry.');
    }

    requireZero(db, 'unsupported legacy item kind', `
      SELECT COUNT(*) AS count FROM rss_items
      WHERE item_type IS NULL OR item_type NOT IN ('article', 'podcast')
    `);
    requireZero(db, 'duplicate legacy source entry identity', `
      SELECT COUNT(*) AS count FROM (
        SELECT source_id, external_guid FROM rss_items
        GROUP BY source_id, external_guid HAVING COUNT(*) > 1
      )
    `);
    requireZero(db, 'orphaned legacy item', `
      SELECT COUNT(*) AS count FROM rss_items i
      LEFT JOIN rss_sources s ON s.id = i.source_id WHERE s.id IS NULL
    `);
    requireZero(db, 'orphaned legacy comment', `
      SELECT COUNT(*) AS count FROM rss_item_comments c
      LEFT JOIN rss_items i ON i.id = c.rss_item_id WHERE i.id IS NULL
    `);
    requireZero(db, 'orphaned legacy block', `
      SELECT COUNT(*) AS count FROM user_rss_source_blocks b
      LEFT JOIN users u ON u.id = b.user_id
      LEFT JOIN rss_sources s ON s.id = b.source_id
      WHERE u.id IS NULL OR s.id IS NULL
    `);
    requireZero(db, 'cross-item legacy comment parent', `
      SELECT COUNT(*) AS count FROM rss_item_comments c
      JOIN rss_item_comments p ON p.id = c.parent_id
      WHERE p.rss_item_id <> c.rss_item_id
    `);
    requireZero(db, 'legacy source value exceeds generalized limits', `
      SELECT COUNT(*) AS count FROM rss_sources
      WHERE length(name) NOT BETWEEN 1 AND 120
         OR length(url) NOT BETWEEN 1 AND 2048
         OR length(COALESCE(homepage_url, '')) > 2048
         OR length(COALESCE(category, 'general')) NOT BETWEEN 1 AND 80
         OR length(COALESCE(last_fetch_error, '')) > 500
    `);
    requireZero(db, 'legacy item value exceeds generalized limits', `
      SELECT COUNT(*) AS count FROM rss_items
      WHERE length(external_guid) NOT BETWEEN 1 AND 2048
         OR length(title) > 500
         OR length(COALESCE(summary, '')) > 1000
         OR length(COALESCE(content_snippet, '')) > 2000
         OR length(COALESCE(author, '')) > 200
         OR length(COALESCE(link_url, '')) > 2048
         OR length(COALESCE(image_url, '')) > 2048
         OR length(COALESCE(episode_image_url, '')) > 2048
         OR length(COALESCE(enclosure_url, '')) > 2048
         OR length(COALESCE(enclosure_type, '')) > 200
         OR length(COALESCE(duration_text, '')) > 100
    `);
    requireZero(db, 'legacy comment value exceeds generalized limits', `
      SELECT COUNT(*) AS count FROM rss_item_comments
      WHERE length(body) NOT BETWEEN 1 AND 2000
    `);

    const expected = {
      sources: count(db, 'SELECT COUNT(*) AS count FROM rss_sources'),
      items: count(db, 'SELECT COUNT(*) AS count FROM rss_items'),
      comments: count(db, 'SELECT COUNT(*) AS count FROM rss_item_comments'),
      blocks: count(db, 'SELECT COUNT(*) AS count FROM user_rss_source_blocks'),
      subscriptions: count(db, `
        SELECT COUNT(*) AS count
        FROM users u CROSS JOIN rss_sources s
        WHERE s.is_active = 1
          AND NOT EXISTS (
            SELECT 1 FROM user_rss_source_blocks b
            WHERE b.user_id = u.id AND b.source_id = s.id
          )
      `),
    };
    if (expected.subscriptions > MAX_CONTINUITY_SUBSCRIPTIONS) {
      throw new Error('External content migration blocked: continuity subscription limit exceeded.');
    }

    db.exec(`
      CREATE TABLE external_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 32 AND provider NOT GLOB '*[^a-z0-9_]*'),
        source_kind TEXT NOT NULL CHECK(length(source_kind) BETWEEN 1 AND 64 AND source_kind NOT GLOB '*[^a-z0-9_]*'),
        provider_source_id TEXT CHECK(provider_source_id IS NULL OR length(provider_source_id) BETWEEN 1 AND 512),
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        fetch_url TEXT NOT NULL DEFAULT '' CHECK(length(fetch_url) <= 2048),
        homepage_url TEXT NOT NULL DEFAULT '' CHECK(length(homepage_url) <= 2048),
        category TEXT NOT NULL DEFAULT 'general' CHECK(length(category) BETWEEN 1 AND 80),
        is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
        tombstoned_at TEXT,
        last_fetched_at TEXT,
        last_fetch_attempt_at TEXT,
        last_failure_code TEXT CHECK(last_failure_code IS NULL OR (length(last_failure_code) BETWEEN 1 AND 64 AND last_failure_code NOT GLOB '*[^A-Z0-9_]*')),
        last_failure_detail TEXT CHECK(last_failure_detail IS NULL OR length(last_failure_detail) <= 500),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK(source_kind <> 'rss' OR length(fetch_url) > 0),
        CHECK(tombstoned_at IS NULL OR is_active = 0)
      );

      CREATE TABLE external_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 32 AND provider NOT GLOB '*[^a-z0-9_]*'),
        provider_item_id TEXT CHECK(provider_item_id IS NULL OR length(provider_item_id) BETWEEN 1 AND 512),
        item_kind TEXT NOT NULL CHECK(item_kind IN ('article', 'podcast', 'video')),
        title TEXT NOT NULL CHECK(length(title) <= 500),
        summary TEXT NOT NULL DEFAULT '' CHECK(length(summary) <= 1000),
        content_snippet TEXT NOT NULL DEFAULT '' CHECK(length(content_snippet) <= 2000),
        author_name TEXT NOT NULL DEFAULT '' CHECK(length(author_name) <= 200),
        canonical_url TEXT NOT NULL DEFAULT '' CHECK(length(canonical_url) <= 2048),
        image_url TEXT NOT NULL DEFAULT '' CHECK(length(image_url) <= 2048),
        episode_image_url TEXT NOT NULL DEFAULT '' CHECK(length(episode_image_url) <= 2048),
        enclosure_url TEXT NOT NULL DEFAULT '' CHECK(length(enclosure_url) <= 2048),
        enclosure_type TEXT NOT NULL DEFAULT '' CHECK(length(enclosure_type) <= 200),
        duration_text TEXT NOT NULL DEFAULT '' CHECK(length(duration_text) <= 100),
        media_provider TEXT CHECK(media_provider IS NULL OR length(media_provider) <= 32),
        video_id TEXT CHECK(video_id IS NULL OR length(video_id) <= 512),
        published_at TEXT,
        provider_updated_at TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_confirmed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE external_source_items (
        source_id INTEGER NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
        item_id INTEGER NOT NULL REFERENCES external_items(id) ON DELETE CASCADE,
        source_entry_id TEXT NOT NULL CHECK(length(source_entry_id) BETWEEN 1 AND 2048),
        source_added_at TEXT,
        source_position INTEGER CHECK(source_position IS NULL OR source_position >= 0),
        first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(source_id, item_id),
        UNIQUE(source_id, source_entry_id)
      );

      CREATE TABLE user_external_source_subscriptions (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_id INTEGER NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(user_id, source_id)
      );

      CREATE TABLE user_external_source_blocks (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_id INTEGER NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(user_id, source_id)
      );

      CREATE TABLE external_item_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_item_id INTEGER NOT NULL REFERENCES external_items(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 2000),
        parent_id INTEGER,
        is_hidden INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(id, external_item_id),
        FOREIGN KEY(parent_id, external_item_id)
          REFERENCES external_item_comments(id, external_item_id)
          ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
      );

      CREATE UNIQUE INDEX idx_external_sources_provider_identity
        ON external_sources(provider, source_kind, provider_source_id)
        WHERE provider_source_id IS NOT NULL;
      CREATE INDEX idx_external_sources_active_refresh
        ON external_sources(is_active, tombstoned_at, last_fetch_attempt_at, id);
      CREATE INDEX idx_external_sources_category
        ON external_sources(category, is_active, id);
      CREATE UNIQUE INDEX idx_external_items_provider_identity
        ON external_items(provider, provider_item_id)
        WHERE provider_item_id IS NOT NULL;
      CREATE INDEX idx_external_items_feed_time
        ON external_items(COALESCE(datetime(published_at), datetime(created_at)) DESC, id DESC);
      CREATE INDEX idx_external_source_items_item
        ON external_source_items(item_id, source_id);
      CREATE INDEX idx_external_subscriptions_source
        ON user_external_source_subscriptions(source_id, user_id);
      CREATE INDEX idx_external_blocks_source
        ON user_external_source_blocks(source_id, user_id);
      CREATE INDEX idx_external_comments_item
        ON external_item_comments(external_item_id, id);
      CREATE INDEX idx_external_comments_parent
        ON external_item_comments(parent_id) WHERE parent_id IS NOT NULL;
      CREATE INDEX idx_external_comments_user
        ON external_item_comments(user_id, id);
    `);

    db.prepare(`
      INSERT INTO external_sources (
        id, provider, source_kind, provider_source_id, name, fetch_url,
        homepage_url, category, is_active, tombstoned_at, last_fetched_at,
        last_fetch_attempt_at, last_failure_code, last_failure_detail,
        created_at, updated_at
      )
      SELECT id, 'rss', 'rss', NULL, name, url,
        COALESCE(homepage_url, ''), COALESCE(category, 'general'), is_active,
        NULL, last_fetched_at, last_fetch_attempt_at,
        CASE WHEN last_fetch_error IS NULL THEN NULL ELSE 'RSS_FETCH_FAILED' END,
        last_fetch_error, created_at, updated_at
      FROM rss_sources ORDER BY id
    `).run();

    db.prepare(`
      INSERT INTO external_items (
        id, provider, provider_item_id, item_kind, title, summary,
        content_snippet, author_name, canonical_url, image_url,
        episode_image_url, enclosure_url, enclosure_type, duration_text,
        media_provider, video_id, published_at, provider_updated_at,
        fetched_at, last_confirmed_at, created_at, updated_at
      )
      SELECT id, 'rss', NULL, item_type, title, COALESCE(summary, ''),
        COALESCE(content_snippet, ''), COALESCE(author, ''), COALESCE(link_url, ''),
        COALESCE(image_url, ''), COALESCE(episode_image_url, ''),
        COALESCE(enclosure_url, ''), COALESCE(enclosure_type, ''),
        COALESCE(duration_text, ''), NULL, NULL, published_at, NULL,
        COALESCE(fetched_at, created_at, datetime('now')),
        COALESCE(fetched_at, created_at, datetime('now')),
        COALESCE(created_at, fetched_at, datetime('now')),
        COALESCE(fetched_at, created_at, datetime('now'))
      FROM rss_items ORDER BY id
    `).run();

    db.prepare(`
      INSERT INTO external_source_items (
        source_id, item_id, source_entry_id, source_added_at,
        source_position, first_seen_at, last_seen_at
      )
      SELECT source_id, id, external_guid, NULL, NULL,
        COALESCE(fetched_at, created_at, datetime('now')),
        COALESCE(fetched_at, created_at, datetime('now'))
      FROM rss_items ORDER BY id
    `).run();

    db.prepare(`
      INSERT INTO external_item_comments (
        id, external_item_id, user_id, body, parent_id, is_hidden, created_at
      )
      SELECT id, rss_item_id, user_id, body, parent_id, is_hidden, created_at
      FROM rss_item_comments ORDER BY id
    `).run();

    db.prepare(`
      INSERT INTO user_external_source_blocks(user_id, source_id, created_at)
      SELECT user_id, source_id, created_at
      FROM user_rss_source_blocks ORDER BY user_id, source_id
    `).run();

    db.prepare(`
      INSERT INTO user_external_source_subscriptions(user_id, source_id, created_at)
      SELECT u.id, s.id, datetime('now')
      FROM users u CROSS JOIN external_sources s
      WHERE s.provider = 'rss'
        AND s.source_kind = 'rss'
        AND s.is_active = 1
        AND s.tombstoned_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_external_source_blocks b
          WHERE b.user_id = u.id AND b.source_id = s.id
        )
      ORDER BY u.id, s.id
    `).run();

    requireEqual('source count', count(db, 'SELECT COUNT(*) AS count FROM external_sources'), expected.sources);
    requireEqual('item count', count(db, 'SELECT COUNT(*) AS count FROM external_items'), expected.items);
    requireEqual('membership count', count(db, 'SELECT COUNT(*) AS count FROM external_source_items'), expected.items);
    requireEqual('comment count', count(db, 'SELECT COUNT(*) AS count FROM external_item_comments'), expected.comments);
    requireEqual('block count', count(db, 'SELECT COUNT(*) AS count FROM user_external_source_blocks'), expected.blocks);
    requireEqual('subscription count', count(db, 'SELECT COUNT(*) AS count FROM user_external_source_subscriptions'), expected.subscriptions);

    requireZero(db, 'source ID mapping mismatch', `SELECT COUNT(*) AS count FROM (SELECT id FROM rss_sources EXCEPT SELECT id FROM external_sources)`);
    requireZero(db, 'item ID mapping mismatch', `SELECT COUNT(*) AS count FROM (SELECT id FROM rss_items EXCEPT SELECT id FROM external_items)`);
    requireZero(db, 'comment ID mapping mismatch', `SELECT COUNT(*) AS count FROM (SELECT id FROM rss_item_comments EXCEPT SELECT id FROM external_item_comments)`);

    for (const table of TARGET_TABLES) {
      const violations = db.pragma(`foreign_key_check(${table})`) as unknown[];
      if (violations.length) throw new Error('External content migration validation failed: foreign-key integrity.');
    }
  });
}
