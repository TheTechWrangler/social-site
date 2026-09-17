import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-external-foundation-'));
const databasePath = path.join(root, 'data', 'foundation.db');
const uploadsDir = path.join(root, 'uploads');
assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
Object.assign(process.env, {
  NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null',
  DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir,
});

let db: ReturnType<typeof import('../../server/database.js')['getDb']>;
let database: typeof import('../../server/database.js');
let rss: typeof import('../../server/rssService.js');
let external: typeof import('../../server/externalContentService.js');

before(async () => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  database = await import('../../server/database.js');
  database.initializeDatabase();
  db = database.getDb();
  rss = await import('../../server/rssService.js');
  external = await import('../../server/externalContentService.js');
});

after(() => {
  db?.close();
  if (!root.startsWith(path.join(os.tmpdir(), 'refugecloud-external-foundation-'))) {
    throw new Error(`Refusing to clean unexpected test path: ${root}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`
    DELETE FROM external_item_comments;
    DELETE FROM external_source_items;
    DELETE FROM user_external_source_blocks;
    DELETE FROM user_external_source_subscriptions;
    DELETE FROM external_items;
    DELETE FROM external_sources;
    DELETE FROM users;
    DELETE FROM rss_item_comments;
    DELETE FROM rss_items;
    DELETE FROM user_rss_source_blocks;
    DELETE FROM rss_sources;
  `);
});

function user(id: number): void {
  db.prepare(`INSERT INTO users(id,username,display_name,email,password_hash,is_verified)
    VALUES (?, ?, ?, ?, 'test', 1)`).run(id, `user${id}`, `User ${id}`, `user${id}@test.invalid`);
}

function source(name: string, active = 1): number {
  return Number(db.prepare(`INSERT INTO external_sources(provider,source_kind,name,fetch_url,is_active)
    VALUES ('rss','rss',?,'https://feed.example/rss',?)`).run(name, active).lastInsertRowid);
}

function item(sourceId: number, entryId: string, title: string, publishedAt: string): number {
  const itemId = Number(db.prepare(`INSERT INTO external_items(provider,item_kind,title,canonical_url,published_at)
    VALUES ('rss','article',?,'https://feed.example/item',?)`).run(title, publishedAt).lastInsertRowid);
  db.prepare(`INSERT INTO external_source_items(source_id,item_id,source_entry_id) VALUES (?,?,?)`).run(sourceId, itemId, entryId);
  return itemId;
}

test('RSS persistence is generalized, source-scoped, idempotent, and never dual-writes legacy RSS tables', () => {
  const firstSource = rss.addSource('First', 'https://one.example/rss', 'https://one.example/', 'news');
  const secondSource = rss.addSource('Second', 'https://two.example/rss', '', 'news');
  const feed = { items: [{ guid: 'shared-guid', title: 'Story', link: 'https://item.example/story', pubDate: '2026-01-02T00:00:00Z' }] };

  assert.equal(rss.persistFetchedFeed(db, firstSource, feed).inserted, 1);
  assert.equal(rss.persistFetchedFeed(db, firstSource, feed).dupes, 1);
  assert.equal(rss.persistFetchedFeed(db, secondSource, feed).inserted, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM external_items').get() as any).count, 2);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM external_source_items').get() as any).count, 2);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM rss_sources').get() as any).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM rss_items').get() as any).count, 0);

  const stale = rss.getSources().find(row => row.id === firstSource.id)!;
  rss.updateSource(firstSource.id, { category: 'changed' });
  assert.throws(() => rss.persistFetchedFeed(db, stale, { items: [{ guid: 'later', title: 'Late' }] }), /configuration changed/);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM external_source_items WHERE source_entry_id='later'").get() as any).count, 0);
});

test('personal and World feeds apply subscription, active, tombstone, and block semantics', () => {
  user(1); user(2);
  const first = source('First');
  const second = source('Second');
  const disabled = source('Disabled', 0);
  const firstItem = item(first, 'first', 'First item', '2026-01-03T00:00:00Z');
  const secondItem = item(second, 'second', 'Second item', '2026-01-02T00:00:00Z');
  item(disabled, 'disabled', 'Disabled item', '2026-01-04T00:00:00Z');
  db.prepare('INSERT INTO user_external_source_subscriptions(user_id,source_id) VALUES (1,?),(1,?)').run(first, disabled);

  assert.deepEqual(external.getExternalFeed({ scope: 'personal', userId: 1 }).map(row => row.id), [firstItem]);
  assert.deepEqual(external.getExternalFeed({ scope: 'personal' }), []);
  assert.deepEqual(external.getExternalFeed({ scope: 'world', userId: 1 }).map(row => row.id), [firstItem, secondItem]);
  assert.equal(external.getPersonalExternalFeedStatus(1), 'ready');
  assert.equal(external.getPersonalExternalFeedStatus(2), 'no_subscriptions');

  external.blockSource(1, first);
  assert.deepEqual(external.getExternalFeed({ scope: 'personal', userId: 1 }), []);
  assert.deepEqual(external.getExternalFeed({ scope: 'world', userId: 1 }).map(row => row.id), [secondItem]);
  assert.equal(external.getPersonalExternalFeedStatus(1), 'no_active_subscriptions');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions WHERE user_id=1 AND source_id=?').get(first) as any).count, 1);
});

test('subscriptions are server-confirmed, idempotent, blocked-aware, and never automatic for later users or sources', () => {
  user(1); user(2);
  const active = source('Active');
  const inactive = source('Inactive', 0);
  assert.deepEqual(external.subscribeToSource(1, active), { ok: true, value: { sourceId: active, subscribed: true, blocked: false } });
  assert.deepEqual(external.subscribeToSource(1, active), { ok: true, value: { sourceId: active, subscribed: true, blocked: false } });
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions WHERE user_id=1').get() as any).count, 1);
  assert.deepEqual(external.subscribeToSource(1, inactive), { ok: false, reason: 'unavailable' });
  external.blockSource(2, active);
  assert.deepEqual(external.subscribeToSource(2, active), { ok: false, reason: 'blocked' });
  assert.deepEqual(external.unsubscribeFromSource(1, active), { sourceId: active, subscribed: false, blocked: false });
  assert.deepEqual(external.unsubscribeFromSource(1, active), { sourceId: active, subscribed: false, blocked: false });

  user(3);
  const later = source('Later');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions WHERE user_id=3 OR source_id=?').get(later) as any).count, 0);
});

test('public catalog is allowlisted and retains unavailable state only for the viewer own subscription', () => {
  user(1);
  const active = source('Active');
  const disabled = source('Disabled', 0);
  db.prepare(`UPDATE external_sources SET homepage_url='https://public.example/', last_failure_code='RSS_FETCH_FAILED',
    last_failure_detail='secret internal response', last_fetch_attempt_at='2026-01-01' WHERE id=?`).run(active);
  db.prepare('INSERT INTO user_external_source_subscriptions(user_id,source_id) VALUES (1,?)').run(disabled);

  const anonymous = external.getPublicSourceCatalog();
  assert.deepEqual(anonymous.sources.map(row => row.id), [active]);
  assert.deepEqual(Object.keys(anonymous.sources[0]).sort(), ['availability', 'category', 'homepageUrl', 'id', 'name', 'sourceKind', 'viewer']);
  assert.equal(anonymous.sources[0].viewer, null);
  const serialized = JSON.stringify(anonymous);
  assert.doesNotMatch(serialized, /fetch_url|last_failure|secret internal|feed\.example/);

  const personalized = external.getPublicSourceCatalog(1);
  assert.deepEqual(personalized.sources.map(row => [row.id, row.availability, row.viewer?.subscribed]), [
    [active, 'active', false], [disabled, 'disabled', true],
  ]);
});

test('retention deletes expired generalized items, preserves visible discussions, and leaves legacy rows untouched', () => {
  user(1);
  const externalSource = source('Retention');
  const unprotected = item(externalSource, 'old-a', 'Old A', '2000-01-01T00:00:00Z');
  const protectedItem = item(externalSource, 'old-b', 'Old B', '2000-01-01T00:00:00Z');
  const hiddenOnly = item(externalSource, 'old-c', 'Old C', '2000-01-01T00:00:00Z');
  db.prepare(`INSERT INTO external_item_comments(external_item_id,user_id,body) VALUES (?,1,'visible')`).run(protectedItem);
  db.prepare(`INSERT INTO external_item_comments(external_item_id,user_id,body,is_hidden) VALUES (?,1,'hidden',1)`).run(hiddenOnly);
  db.prepare(`INSERT INTO rss_sources(id,name,url) VALUES (99,'Legacy snapshot','https://legacy.example/rss')`).run();
  db.prepare(`INSERT INTO rss_items(id,source_id,external_guid,title,link_url,published_at)
    VALUES (99,99,'legacy','Legacy','https://legacy.example/item','2000-01-01')`).run();

  database.runRetentionCleanup();
  assert.equal(db.prepare('SELECT 1 FROM external_items WHERE id=?').get(unprotected), undefined);
  assert.ok(db.prepare('SELECT 1 FROM external_items WHERE id=?').get(protectedItem));
  assert.equal(db.prepare('SELECT 1 FROM external_items WHERE id=?').get(hiddenOnly), undefined);
  assert.ok(db.prepare('SELECT 1 FROM rss_items WHERE id=99').get());
});
