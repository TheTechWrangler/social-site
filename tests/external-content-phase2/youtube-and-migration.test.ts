import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import Database from 'better-sqlite3';
import { migrateExternalContentPhase2, EXTERNAL_CONTENT_PHASE2_MIGRATION_ID } from '../../server/externalContentPhase2Migration.js';
import {
  parseYouTubeChannelLocator,
  youtubeChannelFeedUrl,
  youtubeChannelHomepageUrl,
  youtubeEmbedUrl,
  youtubeThumbnailUrl,
  youtubeWatchUrl,
} from '../../shared/youtube.js';
import {
  downloadYouTubeChannelFeed,
  parseYouTubeAtom,
  persistYouTubeFeed,
  validateYouTubeFeedDestination,
} from '../../server/youtubeService.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-phase2-youtube-'));
const databasePath = path.join(root, 'data', 'phase2.db');
const uploadsDir = path.join(root, 'uploads');
assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
Object.assign(process.env, {
  NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir,
});

const CHANNEL = `UC${'a'.repeat(22)}`;
const SECOND_CHANNEL = `UC${'b'.repeat(22)}`;
const VIDEO = 'abcDEF_1234';

function atom(channel = CHANNEL, video = VIDEO): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <id>yt:channel:${channel}</id><yt:channelId>${channel}</yt:channelId><title>Safe Channel</title>
      <entry><id>yt:video:${video}</id><yt:videoId>${video}</yt:videoId><yt:channelId>${channel}</yt:channelId>
        <title>Safe Video</title><published>2026-09-16T12:00:00Z</published><updated>2026-09-16T13:00:00Z</updated>
        <media:group><media:description>Safe &amp; useful &lt;b&gt;description&lt;/b&gt;</media:description></media:group>
      </entry>
    </feed>`;
}

function phase1Shape(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT);
    CREATE TABLE external_sources(id INTEGER PRIMARY KEY, is_active INTEGER DEFAULT 1, tombstoned_at TEXT);
  `);
  return db;
}

test('Phase 2 migration is ledgered, constrained, indexed, restart-safe, and refuses unexpected adoption', () => {
  const db = phase1Shape();
  try {
    migrateExternalContentPhase2(db);
    const columns = (db.pragma('table_info(external_source_submissions)') as any[]).map(row => row.name);
    assert.deepEqual(columns, ['id', 'submitted_by_user_id', 'proposed_kind', 'proposed_locator', 'proposed_name', 'proposed_category', 'note', 'status', 'reviewed_by_user_id', 'reviewed_at', 'resulting_source_id', 'review_note', 'created_at', 'updated_at']);
    const indexes = (db.pragma('index_list(external_source_submissions)') as any[]).map(row => row.name);
    for (const name of ['idx_external_source_submissions_status', 'idx_external_source_submissions_submitter', 'idx_external_source_submissions_result', 'idx_external_source_submissions_pending_unique']) assert.ok(indexes.includes(name));
    assert.equal((db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE id=?').get(EXTERNAL_CONTENT_PHASE2_MIGRATION_ID) as any).count, 1);
    migrateExternalContentPhase2(db);
    assert.equal((db.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE id=?').get(EXTERNAL_CONTENT_PHASE2_MIGRATION_ID) as any).count, 1);
    assert.throws(() => db.prepare(`INSERT INTO external_source_submissions(submitted_by_user_id,proposed_kind,proposed_locator,status) VALUES (NULL,'playlist','x','pending')`).run(), /CHECK/);
  } finally { db.close(); }

  const unexpected = phase1Shape();
  try {
    unexpected.exec('CREATE TABLE external_source_submissions(id INTEGER)');
    assert.throws(() => migrateExternalContentPhase2(unexpected), /exists without a ledger entry/);
    assert.equal(!!unexpected.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get(), false);
  } finally { unexpected.close(); }
});

test('YouTube locators accept only channel IDs or canonical HTTPS channel URLs and derive all provider URLs', () => {
  assert.equal(parseYouTubeChannelLocator(CHANNEL), CHANNEL);
  assert.equal(parseYouTubeChannelLocator(`https://www.youtube.com/channel/${CHANNEL}`), CHANNEL);
  assert.equal(parseYouTubeChannelLocator(`https://youtube.com/channel/${CHANNEL}/`), CHANNEL);
  for (const invalid of [
    'UCshort', `https://evil.example/channel/${CHANNEL}`, `http://youtube.com/channel/${CHANNEL}`,
    `https://youtube.com/@handle`, `https://youtube.com/channel/${CHANNEL}?x=1`,
    `https://youtube.com/playlist?list=${CHANNEL}`, `https://user:pass@youtube.com/channel/${CHANNEL}`,
  ]) assert.equal(parseYouTubeChannelLocator(invalid), null, invalid);
  assert.equal(youtubeChannelFeedUrl(CHANNEL), `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`);
  assert.equal(youtubeChannelHomepageUrl(CHANNEL), `https://www.youtube.com/channel/${CHANNEL}`);
  assert.equal(youtubeWatchUrl(VIDEO), `https://www.youtube.com/watch?v=${VIDEO}`);
  assert.equal(youtubeEmbedUrl(VIDEO), `https://www.youtube-nocookie.com/embed/${VIDEO}`);
  assert.equal(youtubeThumbnailUrl(VIDEO), `https://i.ytimg.com/vi/${VIDEO}/hqdefault.jpg`);
});

test('YouTube destination policy is exact and remains stricter than the general SSRF policy', () => {
  assert.doesNotThrow(() => validateYouTubeFeedDestination(new URL(youtubeChannelFeedUrl(CHANNEL)), CHANNEL));
  for (const value of [
    `http://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
    `https://youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`,
    `https://www.youtube.com/watch?v=${VIDEO}`,
    `https://www.youtube.com/feeds/videos.xml?channel_id=${SECOND_CHANNEL}`,
    `https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}&extra=1`,
    `https://evil.example/feeds/videos.xml?channel_id=${CHANNEL}`,
  ]) assert.throws(() => validateYouTubeFeedDestination(new URL(value), CHANNEL), /not approved/);
});

test('Atom parsing validates channel and video identity, rejects malformed/mismatched feeds, and bounds workload', async () => {
  const parsed = await parseYouTubeAtom(atom(), CHANNEL);
  assert.deepEqual(parsed, {
    channelId: CHANNEL,
    channelName: 'Safe Channel',
    entries: [{
      videoId: VIDEO, title: 'Safe Video', description: 'Safe & useful description', channelName: 'Safe Channel',
      publishedAt: '2026-09-16T12:00:00.000Z', providerUpdatedAt: '2026-09-16T13:00:00.000Z',
    }],
  });
  await assert.rejects(parseYouTubeAtom(atom(SECOND_CHANNEL), CHANNEL), /identity/);
  await assert.rejects(parseYouTubeAtom('<feed>', CHANNEL), /valid Atom/);
  await assert.rejects(parseYouTubeAtom('<!DOCTYPE feed><feed/>', CHANNEL), /limits/);
  const tooMany = atom().replace('</feed>', Array.from({ length: 500 }, (_, index) => `<entry><yt:videoId>${String(index).padStart(11, '0')}</yt:videoId><yt:channelId>${CHANNEL}</yt:channelId><title>x</title><published>2026-01-01</published></entry>`).join('') + '</feed>');
  await assert.rejects(parseYouTubeAtom(tooMany, CHANNEL), /item count/);
});

let database: typeof import('../../server/database.js');
let db: ReturnType<typeof import('../../server/database.js')['getDb']>;

before(async () => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  database = await import('../../server/database.js');
  database.initializeDatabase();
  db = database.getDb();
});

after(() => {
  db?.close();
  if (!root.startsWith(path.join(os.tmpdir(), 'refugecloud-phase2-youtube-'))) throw new Error(`Unsafe cleanup: ${root}`);
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  if (!db) return;
  db.exec(`DELETE FROM external_item_comments; DELETE FROM external_source_items; DELETE FROM user_external_source_blocks;
    DELETE FROM user_external_source_subscriptions; DELETE FROM external_source_submissions; DELETE FROM external_items;
    DELETE FROM external_sources; DELETE FROM users;`);
});

function addYoutubeSource(id: number, channel: string) {
  const feedUrl = youtubeChannelFeedUrl(channel);
  db.prepare(`INSERT INTO external_sources(id,provider,source_kind,provider_source_id,name,fetch_url,homepage_url,category)
    VALUES (?,'youtube','youtube_channel',?,'Channel',?,?,'video')`)
    .run(id, channel, feedUrl, youtubeChannelHomepageUrl(channel));
  return db.prepare(`SELECT id,name,fetch_url,homepage_url,category,is_active,tombstoned_at,provider_source_id FROM external_sources WHERE id=?`).get(id) as any;
}

test('YouTube persistence globally deduplicates video identity, safely updates memberships, and rejects stale source configuration', async () => {
  const parsed = await parseYouTubeAtom(atom(), CHANNEL);
  const first = addYoutubeSource(100, CHANNEL);
  const second = addYoutubeSource(200, SECOND_CHANNEL);
  assert.deepEqual(persistYouTubeFeed(db, first, parsed), { inserted: 1, dupes: 0, itemsFound: 1 });
  assert.deepEqual(persistYouTubeFeed(db, first, parsed), { inserted: 0, dupes: 1, itemsFound: 1 });
  assert.deepEqual(persistYouTubeFeed(db, second, { ...parsed, channelId: SECOND_CHANNEL }), { inserted: 0, dupes: 1, itemsFound: 1 });
  assert.equal((db.prepare("SELECT COUNT(*) count FROM external_items WHERE provider='youtube' AND provider_item_id=?").get(VIDEO) as any).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM external_source_items').get() as any).count, 2);
  const item = db.prepare("SELECT item_kind,media_provider,video_id,canonical_url,image_url FROM external_items WHERE provider_item_id=?").get(VIDEO) as any;
  assert.deepEqual(item, { item_kind: 'video', media_provider: 'youtube', video_id: VIDEO, canonical_url: youtubeWatchUrl(VIDEO), image_url: youtubeThumbnailUrl(VIDEO) });
  db.prepare("UPDATE external_sources SET category='changed' WHERE id=100").run();
  assert.throws(() => persistYouTubeFeed(db, first, parsed), /configuration changed/);
});

test('videos use the same chronological, subscription, and block rules as RSS items', async () => {
  db.prepare(`INSERT INTO users(id,username,display_name,email,password_hash,is_verified) VALUES (1,'viewer','Viewer','viewer@test.invalid','x',1)`).run();
  const source = addYoutubeSource(100, CHANNEL);
  persistYouTubeFeed(db, source, await parseYouTubeAtom(atom(), CHANNEL));
  db.prepare(`INSERT INTO external_sources(id,provider,source_kind,name,fetch_url,category) VALUES (300,'rss','rss','RSS','https://feed.example/rss','news')`).run();
  const rssItem = Number(db.prepare(`INSERT INTO external_items(provider,item_kind,title,canonical_url,published_at) VALUES ('rss','article','Newer','https://item.example','2026-09-17T00:00:00Z')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO external_source_items(source_id,item_id,source_entry_id) VALUES (300,?,'rss-one')`).run(rssItem);
  const external = await import('../../server/externalContentService.js');
  assert.deepEqual(external.getExternalFeed({ scope: 'world', userId: 1 }).map(item => item.itemType), ['article', 'video']);
  assert.deepEqual(external.getExternalFeed({ scope: 'personal', userId: 1 }), []);
  external.subscribeToSource(1, 100);
  assert.deepEqual(external.getExternalFeed({ scope: 'personal', userId: 1 }).map(item => item.itemType), ['video']);
  external.blockSource(1, 100);
  assert.deepEqual(external.getExternalFeed({ scope: 'personal', userId: 1 }), []);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM user_external_source_subscriptions WHERE user_id=1 AND source_id=100').get() as any).count, 1);
});

test('official channel downloads construct the endpoint and reject off-policy redirects before a second request', async () => {
  let mode: 'feed' | 'redirect' = 'feed';
  let requests = 0;
  const fixture = http.createServer((_req, res) => {
    requests += 1;
    if (mode === 'redirect') { res.writeHead(302, { location: `https://evil.example/feeds/videos.xml?channel_id=${CHANNEL}` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/atom+xml' }); res.end(atom());
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as any).port;
  const transport = ((url: URL, options: any, callback: any) => http.request(new URL(url.pathname + url.search, `http://127.0.0.1:${port}`), {
    ...options, lookup: undefined, servername: undefined, headers: { ...options.headers, Host: url.host },
  }, callback)) as typeof https.request;
  const dependencies = { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: transport };
  try {
    assert.equal((await downloadYouTubeChannelFeed(CHANNEL, dependencies)).channelId, CHANNEL);
    mode = 'redirect';
    const before = requests;
    await assert.rejects(downloadYouTubeChannelFeed(CHANNEL, dependencies), /not approved/);
    assert.equal(requests, before + 1);
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});
