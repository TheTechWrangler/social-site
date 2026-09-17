import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  EXTERNAL_CONTENT_MIGRATION_ID,
  migrateExternalContentFoundation,
} from '../../server/externalContentMigration.js';

const TARGET_TABLES = [
  'external_sources', 'external_items', 'external_source_items',
  'user_external_source_subscriptions', 'user_external_source_blocks',
  'external_item_comments',
];

function legacyDatabase(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE rss_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      homepage_url TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      is_active INTEGER DEFAULT 1,
      last_fetched_at TEXT,
      last_fetch_attempt_at TEXT,
      last_fetch_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE rss_items (
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
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, external_guid)
    );
    CREATE TABLE rss_item_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rss_item_id INTEGER NOT NULL REFERENCES rss_items(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      parent_id INTEGER REFERENCES rss_item_comments(id) ON DELETE CASCADE,
      is_hidden INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE user_rss_source_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_id INTEGER NOT NULL REFERENCES rss_sources(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, source_id)
    );
  `);
  return db;
}

function seedRepresentativeLegacy(db: Database.Database): void {
  db.exec(`
    INSERT INTO users(id) VALUES (1), (2);
    INSERT INTO rss_sources(id,name,url,homepage_url,category,is_active,last_fetched_at,last_fetch_attempt_at,last_fetch_error)
      VALUES
      (10,'Active A','https://a.example/feed','https://a.example/','news',1,'2026-01-01','2026-01-02',NULL),
      (20,'Inactive','https://off.example/feed','','news',0,NULL,NULL,'bounded failure'),
      (30,'Active B','https://b.example/feed','','podcasts',1,NULL,NULL,NULL);
    INSERT INTO rss_items(id,source_id,external_guid,title,link_url,published_at,item_type,enclosure_url,enclosure_type)
      VALUES
      (101,10,'entry-a','Article','https://a.example/article','2026-01-03','article','',''),
      (102,30,'entry-b','Episode','https://b.example/episode','2026-01-04','podcast','https://b.example/audio.mp3','audio/mpeg');
    INSERT INTO rss_item_comments(id,rss_item_id,user_id,body,parent_id,is_hidden)
      VALUES (1001,101,1,'parent',NULL,0), (1002,101,2,'reply',1001,0);
    INSERT INTO user_rss_source_blocks(user_id,source_id) VALUES (2,30);
  `);
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

test('migration preserves IDs, discussion identity, metadata, blocks, and continuity subscriptions', () => {
  const db = legacyDatabase();
  try {
    seedRepresentativeLegacy(db);
    migrateExternalContentFoundation(db);

    assert.deepEqual((db.prepare('SELECT id FROM external_sources ORDER BY id').all() as any[]).map(row => row.id), [10, 20, 30]);
    assert.deepEqual((db.prepare('SELECT id FROM external_items ORDER BY id').all() as any[]).map(row => row.id), [101, 102]);
    assert.deepEqual(db.prepare(`SELECT id, external_item_id, parent_id FROM external_item_comments ORDER BY id`).all(), [
      { id: 1001, external_item_id: 101, parent_id: null },
      { id: 1002, external_item_id: 101, parent_id: 1001 },
    ]);
    assert.deepEqual(db.prepare(`SELECT source_id, item_id, source_entry_id FROM external_source_items ORDER BY item_id`).all(), [
      { source_id: 10, item_id: 101, source_entry_id: 'entry-a' },
      { source_id: 30, item_id: 102, source_entry_id: 'entry-b' },
    ]);
    assert.deepEqual(db.prepare(`SELECT user_id, source_id FROM user_external_source_blocks`).all(), [{ user_id: 2, source_id: 30 }]);
    assert.deepEqual(db.prepare(`SELECT user_id, source_id FROM user_external_source_subscriptions ORDER BY user_id, source_id`).all(), [
      { user_id: 1, source_id: 10 }, { user_id: 1, source_id: 30 }, { user_id: 2, source_id: 10 },
    ]);
    const operational = db.prepare(`SELECT fetch_url, last_fetched_at, last_fetch_attempt_at, last_failure_code, last_failure_detail
      FROM external_sources WHERE id=20`).get();
    assert.deepEqual(operational, {
      fetch_url: 'https://off.example/feed', last_fetched_at: null, last_fetch_attempt_at: null,
      last_failure_code: 'RSS_FETCH_FAILED', last_failure_detail: 'bounded failure',
    });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(EXTERNAL_CONTENT_MIGRATION_ID));

    const before = db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions').get() as any;
    migrateExternalContentFoundation(db);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions').get() as any).count, before.count);

    db.prepare('INSERT INTO users(id) VALUES (3)').run();
    db.prepare(`INSERT INTO external_sources(provider,source_kind,name,fetch_url) VALUES ('rss','rss','Later','https://later.example/feed')`).run();
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions WHERE user_id=3 OR source_id>30').get() as any).count, 0);
  } finally { db.close(); }
});

test('integrity preflight failure rolls back every generalized table and ledger write', () => {
  const db = legacyDatabase();
  try {
    seedRepresentativeLegacy(db);
    db.pragma('foreign_keys = OFF');
    db.prepare(`INSERT INTO rss_item_comments(id,rss_item_id,user_id,body,parent_id) VALUES (2000,999,1,'orphan',NULL)`).run();
    db.pragma('foreign_keys = ON');
    assert.throws(() => migrateExternalContentFoundation(db), /orphaned legacy comment/);
    for (const table of TARGET_TABLES) assert.equal(tableExists(db, table), false, table);
    assert.equal(tableExists(db, 'schema_migrations'), false);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM rss_items').get() as any).count, 2);
  } finally { db.close(); }
});

test('migration refuses an unexpected pre-existing generalized table without altering legacy data', () => {
  const db = legacyDatabase();
  try {
    seedRepresentativeLegacy(db);
    db.exec('CREATE TABLE external_sources(unexpected INTEGER)');
    assert.throws(() => migrateExternalContentFoundation(db), /target tables already exist/);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM rss_sources').get() as any).count, 3);
    assert.equal(tableExists(db, 'schema_migrations'), false);
  } finally { db.close(); }
});

test('continuity-subscription cardinality above 250,000 aborts before table creation', () => {
  const db = legacyDatabase();
  try {
    const insertUser = db.prepare('INSERT INTO users(id) VALUES (?)');
    const insertSource = db.prepare(`INSERT INTO rss_sources(id,name,url,is_active) VALUES (?,?,'https://feed.example/rss',1)`);
    db.transaction(() => {
      for (let id = 1; id <= 501; id += 1) insertUser.run(id);
      for (let id = 1; id <= 500; id += 1) insertSource.run(id, `Source ${id}`);
    })();
    assert.throws(() => migrateExternalContentFoundation(db), /continuity subscription limit exceeded/);
    for (const table of TARGET_TABLES) assert.equal(tableExists(db, table), false, table);
    assert.equal(tableExists(db, 'schema_migrations'), false);
  } finally { db.close(); }
});

test('same-item parent constraint rejects cross-item discussion linkage after migration', () => {
  const db = legacyDatabase();
  try {
    seedRepresentativeLegacy(db);
    migrateExternalContentFoundation(db);
    assert.throws(() => db.prepare(`INSERT INTO external_item_comments(external_item_id,user_id,body,parent_id)
      VALUES (102,1,'invalid cross-item reply',1001)`).run(), /FOREIGN KEY/);
  } finally { db.close(); }
});
