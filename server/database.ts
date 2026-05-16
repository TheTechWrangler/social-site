import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'social.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function getDb(): Database.Database { return db; }

export function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      role TEXT DEFAULT 'user' CHECK(role IN ('user','mod','admin')),
      banned INTEGER DEFAULT 0,
      is_verified INTEGER DEFAULT 0,
      verified_at TEXT,
      verified_by INTEGER,
      profile_visibility TEXT DEFAULT 'public' CHECK(profile_visibility IN ('public','private')),
      feed_exposure TEXT DEFAULT 'extended' CHECK(feed_exposure IN ('friends_only','mixed','everyone','friends','extended','world')),
      world_home_injection TEXT DEFAULT 'world_home_few' CHECK(world_home_injection IN ('world_home_off','world_home_few','world_home_balanced')),
      game_discovery_enabled INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      repost_of INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES groups_table(id) ON DELETE CASCADE,
      hidden INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (follower_id, following_id)
    );

    CREATE TABLE IF NOT EXISTS likes (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      reaction_type TEXT NOT NULL DEFAULT 'like' CHECK(reaction_type IN ('like','love','laugh','wow','support','thoughtful')),
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, post_id, reaction_type)
    );

    CREATE TABLE IF NOT EXISTS groups_table (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES groups_table(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT DEFAULT 'member' CHECK(role IN ('member','mod','admin')),
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('follow','like','comment','repost','group_invite')),
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      group_id INTEGER REFERENCES groups_table(id) ON DELETE CASCADE,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      report_details TEXT DEFAULT '',
      status TEXT DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
      resolved_by INTEGER REFERENCES users(id),
      resolved_at TEXT,
      admin_note TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id);
    CREATE INDEX IF NOT EXISTS idx_posts_group_created ON posts(group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id);
    CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);

    CREATE TABLE IF NOT EXISTS user_auth_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider TEXT NOT NULL CHECK(provider IN ('google','steam')),
      provider_user_id TEXT NOT NULL,
      provider_email TEXT DEFAULT '',
      provider_display_name TEXT DEFAULT '',
      provider_avatar_url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(provider, provider_user_id)
    );

    CREATE TABLE IF NOT EXISTS rss_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      homepage_url TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      is_active INTEGER DEFAULT 1,
      last_fetched_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rss_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES rss_sources(id) ON DELETE CASCADE,
      external_guid TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      content_snippet TEXT DEFAULT '',
      link_url TEXT NOT NULL,
      author TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      published_at TEXT,
      fetched_at TEXT DEFAULT (datetime('now')),
      item_type TEXT DEFAULT 'article',
      enclosure_url TEXT DEFAULT '',
      enclosure_type TEXT DEFAULT '',
      duration_text TEXT DEFAULT '',
      episode_image_url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rss_items_source ON rss_items(source_id);
    CREATE INDEX IF NOT EXISTS idx_rss_items_published ON rss_items(published_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rss_items_guid ON rss_items(source_id, external_guid);

    CREATE TABLE IF NOT EXISTS rss_item_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rss_item_id INTEGER NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      parent_id INTEGER REFERENCES rss_item_comments(id) ON DELETE CASCADE,
      is_hidden INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_rss_comments_item ON rss_item_comments(rss_item_id);
    CREATE INDEX IF NOT EXISTS idx_rss_comments_created ON rss_item_comments(created_at);

    CREATE TABLE IF NOT EXISTS user_rss_source_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES rss_sources(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS post_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL CHECK(media_type IN ('image','external_video','video')),
      url TEXT NOT NULL,
      provider TEXT,
      original_url TEXT,
      mime_type TEXT,
      file_size_bytes INTEGER,
      duration_seconds INTEGER,
      thumbnail_url TEXT,
      alt_text TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      processing_status TEXT DEFAULT 'ready',
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media(post_id);

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      cover_image_url TEXT DEFAULT '',
      description TEXT DEFAULT '',
      platforms TEXT DEFAULT '',
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_game_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      platform TEXT DEFAULT '',
      play_style TEXT DEFAULT '',
      skill_level TEXT DEFAULT '',
      mic_preference TEXT DEFAULT '',
      usual_play_times TEXT DEFAULT '',
      region_or_timezone TEXT DEFAULT '',
      looking_for_group INTEGER DEFAULT 0,
      is_favorite INTEGER DEFAULT 0,
      display_on_profile INTEGER DEFAULT 1,
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, game_id)
    );

    CREATE TABLE IF NOT EXISTS game_lfg_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      body TEXT DEFAULT '',
      platform TEXT DEFAULT '',
      play_style TEXT DEFAULT '',
      desired_group_size INTEGER,
      mic_required INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      expires_at TEXT DEFAULT (datetime('now', '+6 hours')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lfg_game ON game_lfg_posts(game_id);
    CREATE INDEX IF NOT EXISTS idx_lfg_active ON game_lfg_posts(is_active, created_at);
    CREATE INDEX IF NOT EXISTS idx_ugp_game ON user_game_preferences(game_id);

    CREATE TABLE IF NOT EXISTS game_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      host_label TEXT DEFAULT '',
      connection_host TEXT DEFAULT '',
      connection_port INTEGER,
      query_port INTEGER,
      platform TEXT DEFAULT '',
      region_or_timezone TEXT DEFAULT '',
      server_type TEXT DEFAULT '',
      play_style TEXT DEFAULT '',
      max_players INTEGER,
      current_players INTEGER DEFAULT 0,
      status TEXT DEFAULT 'unknown' CHECK(status IN ('online','offline','maintenance','unknown')),
      is_featured INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      join_instructions TEXT DEFAULT '',
      rules_summary TEXT DEFAULT '',
      discord_url TEXT DEFAULT '',
      website_url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_game_servers_game ON game_servers(game_id);

    CREATE TABLE IF NOT EXISTS user_relationship_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocker_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      relationship_type TEXT NOT NULL CHECK(relationship_type IN ('mute','block')),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(blocker_user_id, blocked_user_id, relationship_type)
    );
    CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON user_relationship_blocks(blocker_user_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON user_relationship_blocks(blocked_user_id);

    CREATE TABLE IF NOT EXISTS dm_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS dm_conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_message_id INTEGER,
      deleted_at TEXT,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dm_members_user ON dm_conversation_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_dm_members_convo ON dm_conversation_members(conversation_id);

    CREATE TABLE IF NOT EXISTS dm_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      deleted_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dm_messages_convo ON dm_messages(conversation_id, id);
  `);

  const userColumns = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
  if (!userColumns.some(c => c.name === 'world_home_injection')) {
    db.exec("ALTER TABLE users ADD COLUMN world_home_injection TEXT DEFAULT 'world_home_few'");
  }
  if (!userColumns.some(c => c.name === 'dm_privacy')) {
    db.exec("ALTER TABLE users ADD COLUMN dm_privacy TEXT DEFAULT 'friends_of_friends'");
  }
  if (!userColumns.some(c => c.name === 'last_feed_refresh_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_feed_refresh_at TEXT DEFAULT NULL');
  }
  if (!userColumns.some(c => c.name === 'last_login_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT DEFAULT NULL');
  }

  // ─── auth_events table (append-only login/admin event log) ───
  const authEventsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='auth_events'"
  ).get();
  if (!authEventsExists) {
    db.exec(`
      CREATE TABLE auth_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        reason TEXT DEFAULT '',
        ip_address TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        admin_actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        meta TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_auth_events_user ON auth_events(user_id, created_at);
      CREATE INDEX idx_auth_events_type ON auth_events(event_type, created_at);
      CREATE INDEX idx_auth_events_created ON auth_events(created_at);
    `);
  }

  // ─── usage_events table (privacy-respecting analytics) ───
  const usageEventsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='usage_events'"
  ).get();
  if (!usageEventsExists) {
    db.exec(`
      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        route TEXT,
        feature_area TEXT,
        success INTEGER NOT NULL DEFAULT 1,
        error_code TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata_json TEXT
      );
      CREATE INDEX idx_usage_events_event_type ON usage_events(event_type);
      CREATE INDEX idx_usage_events_created_at ON usage_events(created_at);
      CREATE INDEX idx_usage_events_user_id ON usage_events(user_id);
    `);
  }

  // ─── client_errors table ───
  const clientErrorsExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='client_errors'"
  ).get();
  if (!clientErrorsExists) {
    db.exec(`
      CREATE TABLE client_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        route TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  // ─── password_reset_tokens table ───
  const prtExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='password_reset_tokens'"
  ).get();
  if (!prtExists) {
    db.exec(`
      CREATE TABLE password_reset_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_by_admin_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_prt_user ON password_reset_tokens(user_id);
      CREATE INDEX idx_prt_hash ON password_reset_tokens(token_hash);
    `);
  }

  // ─── sessions table (used by SQLiteSessionStore / express-session) ───
  // IF NOT EXISTS is safe for both fresh installs and existing databases.
  // Stored in the same social.db for a single backup target and unified WAL journal.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid  TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expire TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
  `);
}

// ─── Retention Cleanup ───
// Deletes old rows from append-only log tables and stale RSS/token rows.
// Safe to call at startup. Each table is wrapped independently so one failure
// never blocks the others.
// Defaults: usage_events=90d, auth_events=180d, client_errors=30d,
//           rss_items=180d, password_reset_tokens=30d.
// Override via env vars (integer days).
export function runRetentionCleanup(): void {
  const db = getDb();

  const usageDays   = Math.max(1, parseInt(process.env.USAGE_EVENTS_RETENTION_DAYS      || '90',  10));
  const authDays    = Math.max(1, parseInt(process.env.AUTH_EVENTS_RETENTION_DAYS        || '180', 10));
  const clientDays  = Math.max(1, parseInt(process.env.CLIENT_ERRORS_RETENTION_DAYS      || '30',  10));
  const rssItemDays = Math.max(1, parseInt(process.env.RSS_ITEMS_RETENTION_DAYS          || '180', 10));
  const tokenDays   = Math.max(1, parseInt(process.env.PASSWORD_RESET_TOKENS_RETENTION_DAYS || '30', 10));

  const targets: Array<{ table: string; days: number }> = [
    { table: 'usage_events',  days: usageDays  },
    { table: 'auth_events',   days: authDays   },
    { table: 'client_errors', days: clientDays },
  ];

  for (const { table, days } of targets) {
    try {
      const cutoff = `-${days} days`;
      const result = db
        .prepare(`DELETE FROM ${table} WHERE created_at < datetime('now', ?)`)
        .run(cutoff);
      if (result.changes > 0) {
        console.log(`[retention] ${table}: deleted ${result.changes} rows older than ${days} days`);
      }
    } catch (err: any) {
      // Log but never throw — a cleanup failure must not crash startup.
      console.error(`[retention] ${table} cleanup failed:`, err.message);
    }
  }

  // RSS items: purge old articles, but spare any that have visible comments.
  try {
    const rssCutoff = `-${rssItemDays} days`;
    const result = db.prepare(`
      DELETE FROM rss_items
      WHERE published_at < datetime('now', ?)
        AND NOT EXISTS (
          SELECT 1 FROM rss_item_comments c
          WHERE c.rss_item_id = rss_items.id AND c.is_hidden = 0
        )
    `).run(rssCutoff);
    if (result.changes > 0) {
      console.log(`[retention] rss_items: deleted ${result.changes} rows older than ${rssItemDays} days`);
    }
  } catch (err: any) {
    console.error('[retention] rss_items cleanup failed:', err.message);
  }

  // Password reset tokens: purge tokens whose expiry is old enough that no
  // valid window could ever reference them again.
  try {
    const tokenCutoff = `-${tokenDays} days`;
    const result = db.prepare(`
      DELETE FROM password_reset_tokens
      WHERE expires_at < datetime('now', ?)
    `).run(tokenCutoff);
    if (result.changes > 0) {
      console.log(`[retention] password_reset_tokens: deleted ${result.changes} rows older than ${tokenDays} days`);
    }
  } catch (err: any) {
    console.error('[retention] password_reset_tokens cleanup failed:', err.message);
  }
}
