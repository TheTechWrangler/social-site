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
const JWT_SECRET = 'isolated-batch10-jwt-secret-not-for-production';

let testRoot = '';
let databasePath = '';
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
        socket.close();
        reject(new Error('Could not allocate an isolated port.'));
        return;
      }
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server?.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Isolated server did not start. Log:\n${serverLog.slice(-8000)}`);
}

function cookie(username: string): string {
  const row = db.prepare('SELECT id, username, role, is_verified FROM users WHERE username = ?').get(username) as any;
  const token = jwt.sign({
    id: row.id,
    username: row.username,
    role: row.role,
    is_verified: row.is_verified,
  }, JWT_SECRET, { expiresIn: '10m' });
  return `refugecloud_auth=${token}`;
}

async function request(
  pathname: string,
  username?: string,
  options: RequestInit = {},
): Promise<{ response: Response; body: any }> {
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

function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

function resetState(): void {
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM likes;
    DELETE FROM follows;
    DELETE FROM user_relationship_blocks;
    DELETE FROM posts;
    DELETE FROM group_members;
    DELETE FROM groups_table;
    UPDATE users SET banned = 0, profile_visibility = 'public';
  `);
}

function addPost(username: string, content: string): number {
  return Number(db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)')
    .run(ids[username], content).lastInsertRowid);
}

function notificationCount(type: string, recipient: string, actor: string, postId?: number): number {
  const row = postId === undefined
    ? db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE type = ? AND user_id = ? AND actor_id = ?')
      .get(type, ids[recipient], ids[actor]) as any
    : db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE type = ? AND user_id = ? AND actor_id = ? AND post_id = ?')
      .get(type, ids[recipient], ids[actor], postId) as any;
  return row.c;
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch10-'));
  databasePath = path.join(testRoot, 'data', 'batch10.db');
  const uploadsDir = path.join(testRoot, 'uploads');
  assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DOTENV_CONFIG_PATH: '/dev/null',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      UPLOADS_DIR: uploadsDir,
      JWT_SECRET,
      SESSION_SECRET: 'isolated-batch10-session-secret-not-for-production',
      APP_BASE_URL: baseUrl,
      WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      STEAM_API_KEY: '',
      STEAM_RETURN_URL: '',
      RESEND_API_KEY: '',
      RATE_LIMIT_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  await waitForHealth();

  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, email, password_hash, role, is_verified)
    VALUES (?, ?, ?, 'test-only-hash', ?, 1)
  `);
  for (const [username, role] of [
    ['owner', 'user'],
    ['actor', 'user'],
    ['actor2', 'user'],
    ['outsider', 'user'],
    ['blocked', 'user'],
    ['banned', 'user'],
    ['admin', 'admin'],
  ] as const) {
    ids[username] = Number(insertUser.run(username, username, `${username}@test.invalid`, role).lastInsertRowid);
  }
});

after(async () => {
  db?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => server!.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-batch10-'))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to clean unexpected test path: ${testRoot}`);
  }
});

test('schema enforces durable logical notification and action uniqueness', () => {
  const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_notifications_%_unique'`)
    .all().map((row: any) => row.name).sort();
  assert.deepEqual(indexes, [
    'idx_notifications_comment_unique',
    'idx_notifications_follow_unique',
    'idx_notifications_group_invite_unique',
    'idx_notifications_like_unique',
    'idx_notifications_repost_unique',
  ]);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_likes_user_post_unique'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_posts_user_repost_unique'").get());
});

test('follow notification generation is idempotent, reversible, private, and atomic', async () => {
  resetState();
  let result = await request(`/api/follows/${ids.owner}`, 'actor', { method: 'POST' });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.replayed, false);
  result = await request(`/api/follows/${ids.owner}`, 'actor', { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.replayed, true);
  assert.equal(notificationCount('follow', 'owner', 'actor'), 1);

  assert.equal((await request(`/api/follows/${ids.owner}`, 'actor', { method: 'DELETE' })).response.status, 200);
  assert.equal(notificationCount('follow', 'owner', 'actor'), 0);
  assert.equal((await request(`/api/follows/${ids.owner}`, 'actor', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/follows/${ids.owner}`, 'actor', { method: 'POST' })).response.status, 200);
  assert.equal(notificationCount('follow', 'owner', 'actor'), 1);

  assert.equal((await request(`/api/users/${ids.blocked}/block`, 'owner', { method: 'POST' })).response.status, 200);
  const blocked = await request(`/api/follows/${ids.owner}`, 'blocked', { method: 'POST' });
  assert.equal(blocked.response.status, 404);
  assert.equal(notificationCount('follow', 'owner', 'blocked'), 0);

  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(ids.banned);
  const banned = await request(`/api/follows/${ids.owner}`, 'banned', { method: 'POST' });
  assert.equal(banned.response.status, 403);
  assert.equal(notificationCount('follow', 'owner', 'banned'), 0);
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(ids.banned);

  db.exec(`CREATE TRIGGER batch10_fail_follow_notification
    BEFORE INSERT ON notifications WHEN NEW.type = 'follow'
    BEGIN SELECT RAISE(FAIL, 'controlled notification failure'); END`);
  try {
    const failed = await request(`/api/follows/${ids.owner}`, 'actor2', { method: 'POST' });
    assert.equal(failed.response.status, 500);
    assert.equal(db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND following_id = ?')
      .get(ids.actor2, ids.owner), undefined);
  } finally {
    db.exec('DROP TRIGGER batch10_fail_follow_notification');
  }
});

test('reaction notification follows one active relationship through set, change, and removal', async () => {
  resetState();
  const postId = addPost('owner', 'reaction source');
  let result = await request(`/api/likes/${postId}`, 'actor', json('POST', { reactionType: 'like' }));
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  const noticeId = (db.prepare("SELECT id FROM notifications WHERE type = 'like'").get() as any).id;

  assert.equal((await request(`/api/likes/${postId}`, 'actor', json('POST', { reactionType: 'like' }))).response.status, 200);
  assert.equal((await request(`/api/likes/${postId}`, 'actor', json('POST', { reactionType: 'love' }))).response.status, 200);
  assert.deepEqual(db.prepare('SELECT reaction_type FROM likes WHERE user_id = ? AND post_id = ?').all(ids.actor, postId), [
    { reaction_type: 'love' },
  ]);
  assert.equal(notificationCount('like', 'owner', 'actor', postId), 1);
  assert.equal((db.prepare("SELECT id FROM notifications WHERE type = 'like'").get() as any).id, noticeId);

  assert.equal((await request(`/api/likes/${postId}`, 'actor', { method: 'DELETE' })).response.status, 200);
  assert.equal(notificationCount('like', 'owner', 'actor', postId), 0);
  assert.equal((await request(`/api/likes/${postId}`, 'actor', { method: 'DELETE' })).response.status, 200);

  assert.equal((await request(`/api/likes/${postId}`, 'owner', json('POST', { reactionType: 'like' }))).response.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = actor_id').get<any>().c, 0);
});

test('comments and replies notify the direct parent author as distinct lifecycle-bound events', async () => {
  resetState();
  const rootId = addPost('owner', 'comment source');
  const first = await request(`/api/comments/${rootId}`, 'actor', json('POST', { content: 'first comment' }));
  const second = await request(`/api/comments/${rootId}`, 'actor', json('POST', { content: 'second comment' }));
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.equal(second.response.status, 201, JSON.stringify(second.body));
  assert.equal(notificationCount('comment', 'owner', 'actor'), 2);

  const firstId = first.body.comment.id as number;
  const secondId = second.body.comment.id as number;
  const reply = await request(`/api/comments/${firstId}`, 'actor2', json('POST', { content: 'direct reply' }));
  assert.equal(reply.response.status, 201, JSON.stringify(reply.body));
  const actorNotifications = await request('/api/notifications', 'actor');
  assert.equal(actorNotifications.response.status, 200);
  assert.equal(actorNotifications.body.notifications[0].comment_kind, 'reply');
  assert.equal(actorNotifications.body.notifications[0].post_id, firstId);

  assert.equal((await request(`/api/comments/${rootId}`, 'owner', json('POST', { content: 'owner comment' }))).response.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = actor_id').get<any>().c, 0);

  assert.equal((await request(`/api/posts/${firstId}`, 'actor', { method: 'DELETE' })).response.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(reply.body.comment.id), undefined);
  assert.equal(notificationCount('comment', 'owner', 'actor', firstId), 0);
  assert.equal(notificationCount('comment', 'actor', 'actor2', reply.body.comment.id), 0);
  assert.equal(notificationCount('comment', 'owner', 'actor', secondId), 1);

  assert.equal((await request(`/api/posts/${rootId}`, 'owner', { method: 'DELETE' })).response.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE type = ?').get<any>('comment').c, 0);
});

test('repost generation is retry-safe, self-suppressing, reversible, and source-bound', async () => {
  resetState();
  const originalId = addPost('owner', 'repost source');
  const first = await request(`/api/reposts/${originalId}`, 'actor', { method: 'POST' });
  assert.equal(first.response.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);
  const repostId = first.body.post.id as number;

  for (let retry = 0; retry < 2; retry++) {
    const repeated = await request(`/api/reposts/${originalId}`, 'actor', { method: 'POST' });
    assert.equal(repeated.response.status, 200, JSON.stringify(repeated.body));
    assert.equal(repeated.body.replayed, true);
    assert.equal(repeated.body.post.id, repostId);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM posts WHERE user_id = ? AND repost_of = ?')
    .get<any>(ids.actor, originalId).c, 1);
  assert.equal(notificationCount('repost', 'owner', 'actor', originalId), 1);

  assert.equal((await request(`/api/reposts/${originalId}`, 'owner', { method: 'POST' })).response.status, 201);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = actor_id').get<any>().c, 0);

  assert.equal((await request(`/api/posts/${repostId}`, 'actor', { method: 'DELETE' })).response.status, 200);
  assert.equal(notificationCount('repost', 'owner', 'actor', originalId), 0);
  const recreated = await request(`/api/reposts/${originalId}`, 'actor', { method: 'POST' });
  assert.equal(recreated.response.status, 201);
  assert.notEqual(recreated.body.post.id, repostId);
  assert.equal(notificationCount('repost', 'owner', 'actor', originalId), 1);

  assert.equal((await request(`/api/users/${ids.blocked}/block`, 'owner', { method: 'POST' })).response.status, 200);
  assert.equal((await request(`/api/reposts/${originalId}`, 'blocked', { method: 'POST' })).response.status, 404);
  assert.equal(notificationCount('repost', 'owner', 'blocked', originalId), 0);

  assert.equal((await request(`/api/posts/${originalId}`, 'owner', { method: 'DELETE' })).response.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(recreated.body.post.id), undefined);
  assert.equal(notificationCount('repost', 'owner', 'actor', originalId), 0);
});

test('privacy-aware DTO, block cleanup, bans, and source deletion prevent notification disclosure', async () => {
  resetState();
  const visiblePost = addPost('owner', 'v'.repeat(140));
  assert.equal((await request(`/api/likes/${visiblePost}`, 'actor', json('POST', { reactionType: 'like' }))).response.status, 200);
  let listed = await request('/api/notifications', 'owner');
  assert.equal(listed.response.status, 200);
  assert.deepEqual(Object.keys(listed.body.notifications[0]).sort(), [
    'actor_username', 'comment_kind', 'created_at', 'group_id', 'id', 'post_id', 'post_snippet', 'read', 'type',
  ]);
  assert.equal(listed.body.notifications[0].post_snippet.length, 120);
  assert.equal(JSON.stringify(listed.body).includes('user_id'), false);
  assert.equal(JSON.stringify(listed.body).includes('actor_id'), false);
  assert.equal(JSON.stringify(listed.body).includes('hidden'), false);

  const visibleNoticeId = listed.body.notifications[0].id as number;
  db.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(visiblePost);
  listed = await request('/api/notifications', 'owner');
  assert.equal(listed.body.notifications.length, 0);
  assert.equal((await request('/api/notifications/unread-count', 'owner')).body.count, 0);
  assert.equal((await request(`/api/notifications/${visibleNoticeId}/read`, 'owner', { method: 'PATCH' })).response.status, 404);

  db.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').run(visiblePost);
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(ids.actor);
  assert.equal((await request('/api/notifications', 'owner')).body.notifications.length, 0);
  assert.equal((await request('/api/notifications/unread-count', 'owner')).body.count, 0);
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(ids.actor);

  assert.equal((await request(`/api/users/${ids.actor}/block`, 'owner', { method: 'POST' })).response.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(visibleNoticeId), undefined);

  const groupId = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)')
    .run('Batch 10 group', ids.owner).lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(groupId, ids.owner);
  const groupNoticeId = Number(db.prepare(`
    INSERT INTO notifications (user_id, actor_id, type, group_id) VALUES (?, ?, 'group_invite', ?)
  `).run(ids.outsider, ids.actor2, groupId).lastInsertRowid);
  assert.equal((await request('/api/notifications', 'outsider')).body.notifications[0].group_id, groupId);
  assert.equal((await request(`/api/groups/${groupId}`, 'owner', { method: 'DELETE' })).response.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM notifications WHERE id = ?').get(groupNoticeId), undefined);
});

test('recipient-authorized read operations are idempotent and preserve later unread arrivals', async () => {
  resetState();
  assert.equal((await request(`/api/follows/${ids.owner}`, 'actor', { method: 'POST' })).response.status, 200);
  assert.equal((await request(`/api/follows/${ids.owner}`, 'actor2', { method: 'POST' })).response.status, 200);
  let listed = await request('/api/notifications', 'owner');
  assert.equal(listed.body.notifications.length, 2);
  const [first, second] = listed.body.notifications;
  assert.equal((await request('/api/notifications/unread-count', 'owner')).body.count, 2);

  let marked = await request(`/api/notifications/${first.id}/read`, 'owner', { method: 'PATCH' });
  assert.equal(marked.response.status, 200);
  assert.equal(marked.body.changed, true);
  assert.equal((await request('/api/notifications/unread-count', 'owner')).body.count, 1);
  marked = await request(`/api/notifications/${first.id}/read`, 'owner', { method: 'PATCH' });
  assert.equal(marked.response.status, 200);
  assert.equal(marked.body.changed, false);
  assert.equal((await request(`/api/notifications/${second.id}/read`, 'outsider', { method: 'PATCH' })).response.status, 404);
  assert.equal((await request('/api/notifications/unread-count', 'owner')).body.count, 1);

  let all = await request('/api/notifications/read-all', 'owner', { method: 'POST' });
  assert.equal(all.response.status, 200);
  assert.equal(all.body.changed, 1);
  all = await request('/api/notifications/read-all', 'owner', { method: 'POST' });
  assert.equal(all.body.changed, 0);
  assert.equal((await request('/api/notifications/unread-count', 'owner')).body.count, 0);

  const postId = addPost('owner', 'arrived later');
  const comment = await request(`/api/comments/${postId}`, 'actor', json('POST', { content: 'new event' }));
  assert.equal(comment.response.status, 201);
  assert.equal((await request('/api/notifications/unread-count', 'owner')).body.count, 1);
  assert.equal((await request(`/api/posts/${comment.body.comment.id}`, 'actor', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request('/api/notifications/unread-count', 'owner')).body.count, 0);

  listed = await request('/api/notifications', 'owner');
  assert.equal(listed.body.notifications.every((notice: any) => notice.read === 1), true);
});
