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
      status TEXT DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_posts_user ON posts(user_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at);
    CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id);
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
  `);
}
