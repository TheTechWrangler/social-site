import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const JWT_SECRET = 'isolated-feed-ux-jwt';
let root = '';
let databasePath = '';
let uploadsDir = '';
let baseUrl = '';
let server: ChildProcess | undefined;
let serverLog = '';
let db: Database.Database;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') return reject(new Error('No isolated test port.'));
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function cookie(userId: number): string {
  const row = db.prepare('SELECT id,username,role,is_verified FROM users WHERE id=?').get(userId) as any;
  return `refugecloud_auth=${jwt.sign(row, JWT_SECRET, { expiresIn: '10m' })}`;
}

async function request(pathname: string, options: RequestInit = {}, userId = 2) {
  const headers = new Headers(options.headers);
  headers.set('cookie', cookie(userId));
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('origin', baseUrl);
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(baseUrl + pathname, { redirect: 'manual', ...options, headers });
  const body = await response.json();
  return { response, body };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-feed-ux-'));
  databasePath = path.join(root, 'data', 'feed.db');
  uploadsDir = path.join(root, 'uploads');
  assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', PORT: String(port),
      DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir, JWT_SECRET,
      SESSION_SECRET: 'isolated-feed-ux-session', APP_BASE_URL: baseUrl, WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', STEAM_API_KEY: '', STEAM_RETURN_URL: '',
      RESEND_API_KEY: '', RATE_LIMIT_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(baseUrl + '/api/health')).ok) { healthy = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!healthy || !server || server.exitCode !== null) throw new Error(serverLog);
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    INSERT INTO users(id,username,display_name,email,password_hash,role,is_verified) VALUES
      (2,'feedmember','Feed Member','feed@test.invalid','test','user',1),
      (3,'othermember','Other Member','other-feed@test.invalid','test','user',1);
    INSERT INTO external_sources(id,provider,source_kind,provider_source_id,name,fetch_url,homepage_url,category,is_active) VALUES
      (10,'rss','rss',NULL,'Articles','https://articles.invalid/feed','https://articles.invalid/','news',1),
      (20,'rss','rss',NULL,'Podcasts','https://podcasts.invalid/feed','https://podcasts.invalid/','podcasts',1),
      (30,'youtube','youtube_channel','UCaaaaaaaaaaaaaaaaaaaaaa','Videos','','https://www.youtube.com/channel/UCaaaaaaaaaaaaaaaaaaaaaa','video',1),
      (40,'youtube','youtube_channel','UCbbbbbbbbbbbbbbbbbbbbbb','Unsubscribed','','https://www.youtube.com/channel/UCbbbbbbbbbbbbbbbbbbbbbb','video',1),
      (50,'youtube','youtube_channel','UCcccccccccccccccccccccc','Inactive','','https://www.youtube.com/channel/UCcccccccccccccccccccccc','video',0),
      (60,'youtube','youtube_channel','UCdddddddddddddddddddddd','Blocked','','https://www.youtube.com/channel/UCdddddddddddddddddddddd','video',1);
    INSERT INTO external_items(id,provider,provider_item_id,item_kind,title,canonical_url,media_provider,video_id,published_at) VALUES
      (100,'rss',NULL,'article','Article newest','https://articles.invalid/100',NULL,NULL,'2026-09-17T15:00:00Z'),
      (101,'rss',NULL,'article','Article older','https://articles.invalid/101',NULL,NULL,'2026-09-17T11:00:00Z'),
      (102,'rss',NULL,'article','Article tied lower id','https://articles.invalid/102',NULL,NULL,'2026-09-17T10:00:00Z'),
      (103,'rss',NULL,'article','Article tied higher id','https://articles.invalid/103',NULL,NULL,'2026-09-17T10:00:00Z'),
      (200,'rss',NULL,'podcast','Podcast','https://podcasts.invalid/200',NULL,NULL,'2026-09-17T14:00:00Z'),
      (300,'youtube','aaaaaaaaaaa','video','Video newest','https://www.youtube.com/watch?v=aaaaaaaaaaa','youtube','aaaaaaaaaaa','2026-09-17T16:00:00Z'),
      (301,'youtube','bbbbbbbbbbb','video','Video older','https://www.youtube.com/watch?v=bbbbbbbbbbb','youtube','bbbbbbbbbbb','2026-09-17T13:00:00Z'),
      (400,'youtube','ccccccccccc','video','Unsubscribed video','https://www.youtube.com/watch?v=ccccccccccc','youtube','ccccccccccc','2026-09-17T20:00:00Z'),
      (500,'youtube','ddddddddddd','video','Inactive video','https://www.youtube.com/watch?v=ddddddddddd','youtube','ddddddddddd','2026-09-17T21:00:00Z'),
      (600,'youtube','eeeeeeeeeee','video','Blocked video','https://www.youtube.com/watch?v=eeeeeeeeeee','youtube','eeeeeeeeeee','2026-09-17T22:00:00Z');
    INSERT INTO external_source_items(source_id,item_id,source_entry_id) VALUES
      (10,100,'a100'),(10,101,'a101'),(10,102,'a102'),(10,103,'a103'),(20,200,'p200'),(30,300,'v300'),(30,301,'v301'),
      (40,400,'v400'),(50,500,'v500'),(60,600,'v600');
    INSERT INTO user_external_source_subscriptions(user_id,source_id) VALUES
      (2,10),(2,20),(2,30),(2,50),(2,60),(3,20);
    INSERT INTO user_external_source_blocks(user_id,source_id) VALUES (2,60);
    INSERT INTO posts(id,user_id,content,created_at) VALUES
      (700,2,'Native same-time lower id','2026-09-17T18:00:00Z'),
      (701,2,'Native same-time higher id','2026-09-17T18:00:00Z'),
      (702,2,'Native older','2026-09-17T17:00:00Z');
  `);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server!.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  db?.close();
  assert.ok(root.startsWith(path.join(os.tmpdir(), 'refugecloud-feed-ux-')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('default-on video preference includes subscribed videos and remains private', async () => {
  const { response, body } = await request('/api/feed?level=world&itemType=all&limit=20');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(body.showVideosInFeed, true);
  assert.deepEqual(body.items.map((item: any) => item.id), [300, 100, 200, 301, 101, 103, 102]);
  assert.ok(body.items.some((item: any) => item.itemType === 'video'));
});

test('turning videos off changes no subscriptions; All excludes videos while explicit Videos remains available', async () => {
  const before = (db.prepare('SELECT COUNT(*) count FROM user_external_source_subscriptions WHERE user_id=2').get() as any).count;
  const updated = await request('/api/users/profile', { method: 'PUT', body: JSON.stringify({ showVideosInFeed: false }) });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.authUser.show_videos_in_feed, 0);
  const after = (db.prepare('SELECT COUNT(*) count FROM user_external_source_subscriptions WHERE user_id=2').get() as any).count;
  assert.equal(after, before);

  const all = await request('/api/feed?level=world&itemType=all&limit=20');
  assert.deepEqual(all.body.items.map((item: any) => item.itemType), ['article', 'podcast', 'article', 'article', 'article']);
  const videos = await request('/api/feed?level=world&itemType=video&limit=20');
  assert.deepEqual(videos.body.items.map((item: any) => item.id), [300, 301]);
  assert.equal(videos.body.showVideosInFeed, false);
});

test('temporary type filters preserve subscription, block, active, and tombstone boundaries', async () => {
  const articles = await request('/api/feed?level=world&itemType=article&limit=20');
  const podcasts = await request('/api/feed?level=world&itemType=podcast&limit=20');
  const videos = await request('/api/feed?level=world&itemType=video&limit=20');
  assert.deepEqual(articles.body.items.map((item: any) => item.id), [100, 101, 103, 102]);
  assert.deepEqual(podcasts.body.items.map((item: any) => item.id), [200]);
  assert.deepEqual(videos.body.items.map((item: any) => item.id), [300, 301]);
  assert.ok(!videos.body.items.some((item: any) => [400, 500, 600].includes(item.id)));
});

test('cursor pages are stable, context-bound, duplicate-free, and reset without a cursor', async () => {
  await request('/api/users/profile', { method: 'PUT', body: JSON.stringify({ showVideosInFeed: true }) });
  const first = await request('/api/feed?level=world&itemType=all&limit=2');
  assert.deepEqual(first.body.items.map((item: any) => item.id), [300, 100]);
  assert.equal(typeof first.body.pagination.nextCursor, 'string');
  const cursor = encodeURIComponent(first.body.pagination.nextCursor);
  const second = await request(`/api/feed?level=world&itemType=all&limit=2&cursor=${cursor}`);
  assert.deepEqual(second.body.items.map((item: any) => item.id), [200, 301]);
  assert.deepEqual(new Set([...first.body.items, ...second.body.items].map((item: any) => item.id)).size, 4);
  const reset = await request('/api/feed?level=world&itemType=all&limit=2');
  assert.deepEqual(reset.body.items.map((item: any) => item.id), [300, 100]);

  assert.equal((await request('/api/feed?level=world&itemType=all&cursor=%25')).response.status, 400);
  const invalidTimeCursor = Buffer.from(JSON.stringify({
    v: 1, k: 'external', c: 'world:all', t: -1, i: 100,
  })).toString('base64url');
  assert.equal((await request(`/api/feed?level=world&itemType=all&cursor=${invalidTimeCursor}`)).response.status, 400);
  assert.equal((await request(`/api/feed?level=world&itemType=video&cursor=${cursor}`)).response.status, 400);
  assert.equal((await request(`/api/feed?level=everyone&cursor=${cursor}`)).response.status, 400);
  assert.equal((await request(`/api/feed?level=world&itemType=all&offset=0&cursor=${cursor}`)).response.status, 400);
});

test('external cursor boundary handles equal timestamps and cross-user replay reapplies authorization', async () => {
  const first = await request('/api/feed?level=world&itemType=article&limit=3');
  assert.deepEqual(first.body.items.map((item: any) => item.id), [100, 101, 103]);
  const cursor = encodeURIComponent(first.body.pagination.nextCursor);
  const second = await request(`/api/feed?level=world&itemType=article&limit=3&cursor=${cursor}`);
  assert.deepEqual(second.body.items.map((item: any) => item.id), [102]);

  const allFirst = await request('/api/feed?level=world&itemType=all&limit=2');
  const replayed = await request(`/api/feed?level=world&itemType=all&limit=20&cursor=${encodeURIComponent(allFirst.body.pagination.nextCursor)}`, {}, 3);
  assert.deepEqual(replayed.body.items.map((item: any) => item.id), [200]);

  db.exec(`
    INSERT INTO external_items(id,provider,item_kind,title,canonical_url,published_at) VALUES
      (104,'rss','article','Malformed time','https://articles.invalid/104','2026-99-99T99:99:99Z'),
      (105,'rss','article','Null time','https://articles.invalid/105',NULL);
    INSERT INTO external_source_items(source_id,item_id,source_entry_id) VALUES
      (10,104,'a104'),(10,105,'a105');
  `);
  const invalidTimeFirst = await request('/api/feed?level=world&itemType=article&limit=5');
  assert.deepEqual(invalidTimeFirst.body.items.map((item: any) => item.id), [100, 101, 103, 102, 105]);
  const invalidTimeSecond = await request(`/api/feed?level=world&itemType=article&limit=5&cursor=${encodeURIComponent(invalidTimeFirst.body.pagination.nextCursor)}`);
  assert.deepEqual(invalidTimeSecond.body.items.map((item: any) => item.id), [104]);
});

test('invalid feed type fails closed', async () => {
  assert.equal((await request('/api/feed?level=world&itemType=playlist')).response.status, 400);
  assert.equal((await request('/api/feed?level=everyone&itemType=video')).response.status, 400);
});

test('normal Home feed uses the same stable date-and-id cursor ordering', async () => {
  const first = await request('/api/feed?level=everyone&limit=2');
  assert.deepEqual(first.body.posts.map((post: any) => post.id), [701, 700]);
  const cursor = encodeURIComponent(first.body.pagination.nextCursor);
  const second = await request(`/api/feed?level=everyone&limit=2&cursor=${cursor}`);
  assert.deepEqual(second.body.posts.map((post: any) => post.id), [702]);
  assert.equal(new Set([...first.body.posts, ...second.body.posts].map((post: any) => post.id)).size, 3);
});
