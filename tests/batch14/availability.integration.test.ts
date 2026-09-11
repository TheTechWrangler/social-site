import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const JWT_SECRET = 'isolated-batch14-jwt-secret-not-for-production';

let testRoot = '';
let databasePath = '';
let uploadsDir = '';
let baseUrl = '';
let server: ChildProcess | undefined;
let serverLog = '';
let db: Database.Database;
const ids: Record<string, number> = {};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        socket.close(); reject(new Error('Could not allocate an isolated port.')); return;
      }
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startServer(): Promise<void> {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverLog = '';
  server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', PORT: String(port),
      DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir, JWT_SECRET,
      SESSION_SECRET: 'isolated-batch14-session-secret-not-for-production',
      APP_BASE_URL: baseUrl, WEB_BASE_URL: baseUrl, GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '', STEAM_API_KEY: '', STEAM_RETURN_URL: '',
      RESEND_API_KEY: '', RATE_LIMIT_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Isolated server did not start. Log:\n${serverLog.slice(-8000)}`);
}

async function stopServer(): Promise<void> {
  if (!server || server.exitCode !== null) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => server!.once('exit', resolve)),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

function cookie(username: string): string {
  const row = db.prepare('SELECT id, username, role, is_verified FROM users WHERE username = ?').get(username) as any;
  const token = jwt.sign(row, JWT_SECRET, { expiresIn: '10m' });
  return `refugecloud_auth=${token}`;
}

async function request(pathname: string, username?: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  if (username) headers.set('cookie', cookie(username));
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('origin', baseUrl);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual', ...options, headers });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}


test('extended feed pages one chronological eligible union and keeps World outside native offsets', async () => {
  db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(ids.author, ids.follower);
  db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(ids.follower, ids.outsider);
  const posts: {id: number; time: number}[] = [];
  for (let i = 0; i < 12; i++) {
    const date = i % 2 ? '2026-09-11T12:00:00.000Z' : '2026-09-11 12:00:00';
    const id = Number(db.prepare('INSERT INTO posts (user_id, content, created_at) VALUES (?, ?, ?)').run(i % 3 ? ids.follower : ids.outsider, 'page-' + i, date).lastInsertRowid);
    posts.push({ id, time: Date.parse(date.includes('T') ? date : date + 'Z') });
  }
  const source = Number(db.prepare("INSERT INTO rss_sources (name, url) VALUES ('fixture', 'https://feed.example/')").run().lastInsertRowid);
  db.prepare("INSERT INTO rss_items (source_id, external_guid, title, link_url, published_at) VALUES (?, 'one', 'World', 'https://feed.example/one', '2026-09-11T12:00:00Z')").run(source);
  const seen: number[] = [];
  for (let offset = 0; offset < 12; offset += 4) {
    const result = await request('/api/feed?level=extended&limit=4&offset=' + offset, 'author');
    assert.equal(result.response.status, 200);
    assert.equal(result.body.posts.length, 4);
    assert.deepEqual(result.body.items.map((p: any) => p.id), result.body.posts.map((p: any) => p.id));
    assert.equal(result.body.worldPlacement, 'separate');
    assert.equal(result.body.worldItems.length, offset === 0 ? 1 : 0);
    assert.equal(result.body.pagination.hasMore, offset < 8);
    seen.push(...result.body.posts.map((p: any) => p.id));
  }
  assert.deepEqual(seen, posts.sort((a, b) => b.time - a.time || b.id - a.id).map(p => p.id));
  assert.equal(new Set(seen).size, 12);
  const end = await request('/api/feed?level=extended&limit=4&offset=12', 'author');
  assert.deepEqual(end.body.posts, []);
  assert.equal(end.body.pagination.nextOffset, null);
});

test('strict list pagination rejects invalid, negative, overflow and oversized limits', async () => {
  const post = Number(db.prepare("INSERT INTO posts (user_id, content) VALUES (?, 'parent')").run(ids.author).lastInsertRowid);
  for (const query of ['limit=-1', 'limit=0', 'limit=101', 'limit=NaN', 'limit=1.5', 'limit=9999999999999999999999', 'limit=1&limit=2']) {
    for (const endpoint of ['/api/feed', '/api/world-feed', '/api/messages', '/api/notifications', '/api/comments/' + post]) {
      const result = await request(endpoint + '?' + query, 'author');
      assert.equal(result.response.status, 400, endpoint + '?' + query);
    }
  }
  for (const query of ['offset=-1', 'offset=100001', 'offset=no']) {
    assert.equal((await request('/api/feed?' + query, 'author')).response.status, 400);
  }
});

test('comment ID cursor pages never repeat and retain canonical media descriptions', async () => {
  const parent = Number(db.prepare("INSERT INTO posts (user_id, content) VALUES (?, 'parent')").run(ids.author).lastInsertRowid);
  const all: number[] = [];
  for (let i = 0; i < 7; i++) all.push(Number(db.prepare("INSERT INTO posts (user_id, content, parent_id) VALUES (?, 'comment', ?)").run(ids.outsider, parent).lastInsertRowid));
  db.prepare("INSERT INTO post_media (post_id, media_type, url, alt_text) VALUES (?, 'image', '/fixture.png', 'A fox & snow')").run(all[0]);
  const first = await request('/api/comments/' + parent + '?limit=4', 'author');
  const second = await request('/api/comments/' + parent + '?limit=4&after=' + first.body.nextCursor, 'author');
  assert.deepEqual([...first.body.comments, ...second.body.comments].map(p => p.id), all);
  assert.equal(first.body.comments[0].media[0].alt_text, 'A fox & snow');
  assert.equal(second.body.hasMore, false);
  assert.equal(second.body.nextCursor, null);
});

test('conversation SQL pages preserve total unread and exact message end-of-thread', async () => {
  for (let i = 0; i < 53; i++) {
    const cid = Number(db.prepare('INSERT INTO dm_conversations DEFAULT VALUES').run().lastInsertRowid);
    db.prepare('INSERT INTO dm_conversation_members (conversation_id, user_id) VALUES (?, ?), (?, ?)').run(cid, ids.author, cid, ids.outsider);
    db.prepare("INSERT INTO dm_messages (conversation_id, sender_id, body) VALUES (?, ?, 'hello')").run(cid, ids.outsider);
  }
  const first = await request('/api/messages', 'author');
  const second = await request('/api/messages?offset=' + first.body.nextOffset, 'author');
  assert.equal(first.body.conversations.length, 50);
  assert.equal(second.body.conversations.length, 3);
  assert.equal(new Set([...first.body.conversations, ...second.body.conversations].map(c => c.id)).size, 53);
  assert.equal(first.body.unreadConversationCount, 53);
  assert.equal(second.body.unreadConversationCount, 53);
  assert.equal(second.body.nextOffset, null);
  const cid = first.body.conversations[0].id;
  const thread = await request('/api/messages/' + cid + '?limit=1', 'author');
  assert.equal(thread.body.hasMore, false);
  assert.equal((await request('/api/messages/' + cid + '?before=NaN', 'author')).response.status, 400);
  assert.equal((await request('/api/messages/' + cid, 'groupOwner')).response.status, 404);
});

test('member pagination does not truncate total counts or the current member authority', async () => {
  const group = Number(db.prepare("INSERT INTO groups_table (name, description, owner_id) VALUES ('fixture', '', ?)").run(ids.groupOwner).lastInsertRowid);
  for (const id of Object.values(ids)) db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)").run(group, id, id === ids.author ? 'admin' : 'member');
  const first = await request('/api/groups/' + group + '?limit=2', 'author');
  const second = await request('/api/groups/' + group + '?limit=2&memberAfter=' + first.body.membersPage.nextCursor, 'author');
  assert.equal(first.body.members.length, 2);
  assert.equal(first.body.group.memberCount, Object.keys(ids).length);
  assert.equal(second.body.group.memberRole, 'admin');
  assert.ok(!second.body.members.some(m => m.id === ids.author));
  assert.deepEqual(second.body.posts, []);
});

test('notification pages and exact unread SQL preserve hidden ancestor and block privacy', async () => {
  const parent = Number(db.prepare("INSERT INTO posts (user_id, content) VALUES (?, 'parent')").run(ids.author).lastInsertRowid);
  for (let i = 0; i < 7; i++) {
    const comment = Number(db.prepare("INSERT INTO posts (user_id, content, parent_id) VALUES (?, 'comment', ?)").run(ids.outsider, parent).lastInsertRowid);
    db.prepare("INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'comment', ?)").run(ids.author, ids.outsider, comment);
  }
  const first = await request('/api/notifications?limit=4', 'author');
  const second = await request('/api/notifications?limit=4&before=' + first.body.nextCursor, 'author');
  assert.equal(first.body.notifications.length, 4); assert.equal(second.body.notifications.length, 3);
  assert.equal((await request('/api/notifications/unread-count', 'author')).body.count, 7);
  db.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(parent);
  assert.equal((await request('/api/notifications/unread-count', 'author')).body.count, 0);
  assert.equal((await request('/api/notifications/read-all', 'author', { method: 'POST' })).body.changed, 0);
  db.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').run(parent);
  assert.equal((await request('/api/notifications/read-all', 'author', { method: 'POST' })).body.changed, 7);
  assert.equal((await request('/api/notifications/unread-count', 'author')).body.count, 0);
});

test('legacy unsafe URL fails at fetch time, records safe failure and preserves source configuration', async () => {
  const source = Number(db.prepare("INSERT INTO rss_sources (name, url) VALUES ('legacy', 'http://127.0.0.1/?secret=do-not-log')").run().lastInsertRowid);
  const result = await request('/api/admin/rss/sources/' + source + '/fetch', 'siteAdmin', { method: 'POST' });
  assert.equal(result.response.status, 502);
  assert.match(result.body.error, /public/);
  const row = db.prepare('SELECT * FROM rss_sources WHERE id = ?').get(source) as any;
  assert.equal(row.url, 'http://127.0.0.1/?secret=do-not-log');
  assert.ok(row.last_fetch_attempt_at);
  assert.match(row.last_fetch_error, /public/);
  assert.ok(!serverLog.includes('do-not-log'));
  const invalid = await request('/api/admin/rss/sources', 'siteAdmin', { method: 'POST', body: JSON.stringify({ name: 'bad', url: 'https://user:secret@feed.example/' }) });
  assert.equal(invalid.response.status, 400);
});

test('World pages normalize timestamps, end exactly and paginate discussion without leaking hidden parents', async () => {
  const source = Number(db.prepare("INSERT INTO rss_sources (name, url) VALUES ('fixture', 'https://feed.example/')").run().lastInsertRowid);
  const itemIds: number[] = [];
  for (const date of ['2026-09-11 12:00:00', '2026-09-11T12:00:00.000Z', 'invalid']) {
    itemIds.push(Number(db.prepare("INSERT INTO rss_items (source_id, external_guid, title, link_url, published_at) VALUES (?, ?, 'item', 'https://feed.example/', ?)").run(source, date, date).lastInsertRowid));
  }
  const first = await request('/api/world-feed?sourceId=' + source + '&limit=2', 'author');
  assert.deepEqual(first.body.items.map(i => i.id), [itemIds[1], itemIds[0]]);
  assert.equal(first.body.pagination.nextOffset, 2);
  const second = await request('/api/world-feed?sourceId=' + source + '&limit=2&offset=2', 'author');
  assert.deepEqual(second.body.items.map(i => i.id), [itemIds[2]]);
  assert.equal(second.body.pagination.hasMore, false);
  const worldMode = await request('/api/feed?level=world&limit=3', 'author');
  assert.equal(worldMode.body.pagination.hasMore, false);
  const parent = Number(db.prepare("INSERT INTO rss_item_comments (rss_item_id, user_id, body) VALUES (?, ?, 'parent')").run(itemIds[0], ids.author).lastInsertRowid);
  db.prepare("INSERT INTO rss_item_comments (rss_item_id, user_id, body, parent_id) VALUES (?, ?, 'reply', ?)").run(itemIds[0], ids.outsider, parent);
  const url = '/api/world-feed/' + itemIds[0] + '/comments?limit=1&after=' + parent;
  const reply = await request(url, 'author');
  assert.equal(reply.body.comments.length, 1);
  assert.equal(reply.body.comments[0].parentId, parent);
  assert.equal(reply.body.count, 2); assert.equal(reply.body.hasMore, false);
  db.prepare('UPDATE rss_item_comments SET is_hidden = 1 WHERE id = ?').run(parent);
  assert.equal((await request(url, 'author')).body.comments[0].parentId, null);
  assert.equal((await request('/api/world-feed/' + itemIds[0] + '/comments?limit=101', 'author')).response.status, 400);
});

test('network refresh budget does not consume ordinary reads or status polling', async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 7; i++) statuses.push((await request('/api/admin/rss/sources/999999/fetch', 'siteAdmin', { method: 'POST' })).response.status);
  assert.ok(statuses.includes(404));
  assert.equal(statuses.at(-1), 429);
  assert.equal((await request('/api/world-feed', 'author')).response.status, 200);
  assert.equal((await request('/api/admin/rss/fetch-all/status', 'siteAdmin')).response.status, 200);
});
before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch14-'));
  databasePath = path.join(testRoot, 'data', 'batch14.db');
  uploadsDir = path.join(testRoot, 'uploads');
  assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  await startServer();
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, email, password_hash, role, is_verified)
    VALUES (?, ?, ?, 'test-only-hash', ?, 1)
  `);
  for (const [username, role] of [
    ['author', 'user'], ['outsider', 'user'], ['follower', 'user'],
    ['groupOwner', 'user'], ['groupAdmin', 'user'], ['siteAdmin', 'admin'],
    ['moderator', 'mod'],
  ] as const) {
    ids[username] = Number(insertUser.run(username, username, `${username}@test.invalid`, role).lastInsertRowid);
  }
});

after(async () => {
  db?.close();
  await stopServer();
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-batch14-'))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to clean unexpected test path: ${testRoot}`);
  }
});

beforeEach(() => {
  db.exec(`
    DELETE FROM dm_messages; DELETE FROM dm_conversation_members; DELETE FROM dm_conversations;
    DELETE FROM rss_items; DELETE FROM rss_sources;
    DELETE FROM reports;
    DELETE FROM notifications;
    DELETE FROM post_media;
    DELETE FROM managed_assets;
    DELETE FROM likes;
    DELETE FROM post_submission_keys;
    DELETE FROM posts;
    DELETE FROM follows;
    DELETE FROM group_members;
    DELETE FROM groups_table;
    DELETE FROM user_relationship_blocks;
    UPDATE users SET profile_visibility = 'public', is_verified = 1, banned = 0;
  `);
});
