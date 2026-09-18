import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { FEED_UX_MIGRATION_ID, migrateFeedUxPreferences } from '../../server/feedUxMigration.js';

test('feed UX migration is forward-only, default-on, constrained, and idempotent', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); INSERT INTO users(id) VALUES (1)');
    migrateFeedUxPreferences(db);
    assert.equal((db.prepare('SELECT show_videos_in_feed value FROM users WHERE id=1').get() as any).value, 1);
    db.prepare('INSERT INTO users(id) VALUES (2)').run();
    assert.equal((db.prepare('SELECT show_videos_in_feed value FROM users WHERE id=2').get() as any).value, 1);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE id=?').get(FEED_UX_MIGRATION_ID) as any).count, 1);
    assert.throws(() => db.prepare('UPDATE users SET show_videos_in_feed=2 WHERE id=1').run());
    migrateFeedUxPreferences(db);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE id=?').get(FEED_UX_MIGRATION_ID) as any).count, 1);
  } finally {
    db.close();
  }
});
