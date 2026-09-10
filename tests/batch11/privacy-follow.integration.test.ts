import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const JWT_SECRET = 'isolated-batch11-jwt-secret-not-for-production';

let testRoot = '';
let databasePath = '';
let collisionPath = '';
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
    env: testEnvironment(databasePath, uploadsDir, port),
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

function testEnvironment(dbPath: string, uploadPath: string, port = 0): NodeJS.ProcessEnv {
  const url = `http://127.0.0.1:${port}`;
  return {
    ...process.env,
    NODE_ENV: 'test',
    DOTENV_CONFIG_PATH: '/dev/null',
    PORT: String(port),
    DATABASE_PATH: dbPath,
    UPLOADS_DIR: uploadPath,
    JWT_SECRET,
    SESSION_SECRET: 'isolated-batch11-session-secret-not-for-production',
    APP_BASE_URL: url,
    WEB_BASE_URL: url,
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    STEAM_API_KEY: '',
    STEAM_RETURN_URL: '',
    RESEND_API_KEY: '',
    RATE_LIMIT_ENABLED: 'false',
  };
}

function cookie(username: string): string {
  const row = db.prepare('SELECT id, username, role, is_verified FROM users WHERE username = ?').get(username) as any;
  const token = jwt.sign({ id: row.id, username: row.username, role: row.role, is_verified: row.is_verified }, JWT_SECRET, { expiresIn: '10m' });
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

function json(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

function rebuildLegacyFollows(database: Database.Database, duplicate = false): void {
  database.pragma('foreign_keys = OFF');
  database.exec(`
    DROP TABLE follows;
    CREATE TABLE follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now'))${duplicate ? '' : ', PRIMARY KEY (follower_id, following_id)'}
    );
  `);
  const insert = database.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)');
  insert.run(ids.grandfather, ids.privateOwner);
  if (duplicate) insert.run(ids.grandfather, ids.privateOwner);
  database.pragma('foreign_keys = ON');
}

function resetState(): void {
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM likes;
    DELETE FROM follows;
    DELETE FROM user_relationship_blocks;
    DELETE FROM game_lfg_posts;
    DELETE FROM user_game_preferences;
    DELETE FROM games;
    DELETE FROM posts;
    DELETE FROM group_members;
    DELETE FROM groups_table;
    UPDATE users SET banned = 0, profile_visibility = 'public', game_discovery_enabled = 0, dm_privacy = 'friends_of_friends';
  `);
  db.prepare("UPDATE users SET profile_visibility = 'private', bio = 'PRIVATE BIO' WHERE id = ?").run(ids.privateOwner);
}

function addPost(username: string, content: string, options: { parentId?: number; repostOf?: number; groupId?: number } = {}): number {
  return Number(db.prepare(`
    INSERT INTO posts (user_id, content, parent_id, repost_of, group_id) VALUES (?, ?, ?, ?, ?)
  `).run(ids[username], content, options.parentId ?? null, options.repostOf ?? null, options.groupId ?? null).lastInsertRowid);
}

function relation(follower: string, target: string): any {
  return db.prepare('SELECT * FROM follows WHERE follower_id = ? AND following_id = ?').get(ids[follower], ids[target]);
}

function followNotificationCount(actor: string, recipient: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'follow' AND actor_id = ? AND user_id = ?")
    .get(ids[actor], ids[recipient]) as any).c;
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch11-'));
  databasePath = path.join(testRoot, 'data', 'batch11.db');
  collisionPath = path.join(testRoot, 'data', 'collision.db');
  uploadsDir = path.join(testRoot, 'uploads');
  assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  // Bootstrap the complete current schema, then reconstruct only the legacy
  // follows table to exercise the real migration against a pre-status edge.
  await startServer();
  await stopServer();
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, email, password_hash, role, is_verified, profile_visibility)
    VALUES (?, ?, ?, 'test-only-hash', ?, ?, ?)
  `);
  for (const [username, role, verified, visibility] of [
    ['privateOwner', 'user', 1, 'private'],
    ['publicTarget', 'user', 1, 'public'],
    ['requester', 'user', 1, 'public'],
    ['requester2', 'user', 1, 'public'],
    ['outsider', 'user', 1, 'public'],
    ['blocked', 'user', 1, 'public'],
    ['grandfather', 'user', 1, 'public'],
    ['groupOwner', 'user', 1, 'public'],
    ['unverified', 'user', 0, 'public'],
    ['admin', 'admin', 1, 'public'],
  ] as const) {
    ids[username] = Number(insertUser.run(username, username, `${username}@test.invalid`, role, verified, visibility).lastInsertRowid);
  }
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  fs.copyFileSync(databasePath, collisionPath);

  db = new Database(databasePath);
  rebuildLegacyFollows(db, false);
  db.close();
  const collision = new Database(collisionPath);
  rebuildLegacyFollows(collision, true);
  collision.close();

  await startServer();
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
});

after(async () => {
  db?.close();
  await stopServer();
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-batch11-'))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to clean unexpected test path: ${testRoot}`);
  }
});

test('legacy follows migrate to accepted idempotently and ambiguous collisions fail closed', () => {
  const columns = db.prepare('PRAGMA table_info(follows)').all() as any[];
  assert.ok(columns.some(column => column.name === 'status'));
  assert.equal(relation('grandfather', 'privateOwner').status, 'accepted');

  const repeat = spawnSync(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), [
    '-e', "import { initializeDatabase } from './server/database.ts'; initializeDatabase();",
  ], { cwd: PROJECT_ROOT, env: testEnvironment(databasePath, uploadsDir), encoding: 'utf8' });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM follows').get() as any).c, 1);
  assert.equal(relation('grandfather', 'privateOwner').status, 'accepted');

  const collision = spawnSync(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), [
    '-e', "import { initializeDatabase } from './server/database.ts'; initializeDatabase();",
  ], { cwd: PROJECT_ROOT, env: testEnvironment(collisionPath, path.join(testRoot, 'collision-uploads')), encoding: 'utf8' });
  assert.notEqual(collision.status, 0);
  assert.match(`${collision.stdout}${collision.stderr}`, /duplicate_edges/);
});

test('public follows are immediately accepted, idempotent, listed, counted, and removable', async () => {
  resetState();
  let result = await request(`/api/follows/${ids.publicTarget}`, 'requester', { method: 'POST' });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.relationshipStatus, 'accepted');
  assert.equal(result.body.following, true);
  result = await request(`/api/follows/${ids.publicTarget}`, 'requester', { method: 'POST' });
  assert.equal(result.body.replayed, true);
  assert.equal(relation('requester', 'publicTarget').status, 'accepted');
  assert.equal(followNotificationCount('requester', 'publicTarget'), 1);

  assert.deepEqual((await request('/api/users/me/following', 'requester')).body.users.map((u: any) => u.username), ['publicTarget']);
  assert.deepEqual((await request('/api/users/me/followers', 'publicTarget')).body.users.map((u: any) => u.username), ['requester']);
  const profile = await request('/api/users/publicTarget', 'requester');
  assert.equal(profile.body.user.followerCount, 1);
  assert.equal(profile.body.user.isFollowing, true);

  result = await request(`/api/follows/${ids.publicTarget}`, 'requester', { method: 'DELETE' });
  assert.equal(result.body.relationshipStatus, 'none');
  assert.equal(result.body.removed, true);
  assert.equal(relation('requester', 'publicTarget'), undefined);
  assert.equal(followNotificationCount('requester', 'publicTarget'), 0);
  assert.equal((await request(`/api/follows/${ids.publicTarget}`, 'requester', { method: 'DELETE' })).body.removed, false);
});

test('private requests remain limited until target acceptance and support every removal transition', async () => {
  resetState();
  const privatePost = addPost('privateOwner', 'PRIVATE PROFILE POST');
  let result = await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.relationshipStatus, 'pending');
  assert.equal(result.body.following, false);
  assert.equal((await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' })).body.replayed, true);
  assert.equal(relation('requester', 'privateOwner').status, 'pending');
  assert.equal(followNotificationCount('requester', 'privateOwner'), 0);

  const limited = await request('/api/users/privateOwner', 'requester');
  assert.equal(limited.body.user.limited, true);
  assert.equal(limited.body.user.followStatus, 'pending');
  assert.equal(limited.body.user.bio, undefined);
  assert.equal((await request('/api/users/privateOwner/posts', 'requester')).response.status, 404);
  assert.equal((await request(`/api/posts/${privatePost}`, 'requester')).response.status, 404);
  assert.deepEqual((await request('/api/users/me/following', 'requester')).body.users, []);
  assert.deepEqual((await request('/api/users/me/followers', 'privateOwner')).body.users, []);

  const inbox = await request('/api/follows/requests', 'privateOwner');
  assert.deepEqual(inbox.body.requests.map((item: any) => item.username), ['requester']);
  assert.deepEqual((await request('/api/follows/requests', 'outsider')).body.requests, []);
  assert.equal((await request(`/api/follows/requests/${ids.requester}/accept`, 'outsider', { method: 'POST' })).response.status, 404);

  result = await request(`/api/follows/requests/${ids.requester}/accept`, 'privateOwner', { method: 'POST' });
  assert.equal(result.body.relationshipStatus, 'accepted');
  assert.equal(result.body.replayed, false);
  assert.equal((await request(`/api/follows/requests/${ids.requester}/accept`, 'privateOwner', { method: 'POST' })).body.replayed, true);
  assert.equal(followNotificationCount('requester', 'privateOwner'), 1);
  assert.equal((await request('/api/users/privateOwner', 'requester')).body.user.bio, 'PRIVATE BIO');
  assert.equal((await request(`/api/posts/${privatePost}`, 'requester')).response.status, 200);

  assert.equal((await request(`/api/follows/followers/${ids.requester}`, 'privateOwner', { method: 'DELETE' })).response.status, 200);
  assert.equal(relation('requester', 'privateOwner'), undefined);
  assert.equal(followNotificationCount('requester', 'privateOwner'), 0);
  assert.equal((await request(`/api/follows/followers/${ids.requester}`, 'privateOwner', { method: 'DELETE' })).response.status, 404);

  await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' });
  result = await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'DELETE' });
  assert.equal(result.body.removed, true);
  assert.equal((await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'DELETE' })).body.removed, false);

  await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' });
  assert.equal((await request(`/api/follows/requests/${ids.requester}`, 'privateOwner', { method: 'DELETE' })).response.status, 200);
  assert.equal(relation('requester', 'privateOwner'), undefined);
  assert.equal((await request(`/api/follows/requests/${ids.requester}`, 'privateOwner', { method: 'DELETE' })).response.status, 404);
});

test('privacy mode transitions preserve accepted followers and auto-accept pending requests', async () => {
  resetState();
  db.prepare("UPDATE users SET profile_visibility = 'public' WHERE id = ?").run(ids.privateOwner);
  await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' });
  assert.equal(relation('requester', 'privateOwner').status, 'accepted');

  let update = await request('/api/users/profile', 'privateOwner', json('PUT', { profileVisibility: 'private' }));
  assert.equal(update.response.status, 200, JSON.stringify(update.body));
  assert.equal(relation('requester', 'privateOwner').status, 'accepted');
  await request(`/api/follows/${ids.privateOwner}`, 'requester2', { method: 'POST' });
  assert.equal(relation('requester2', 'privateOwner').status, 'pending');
  assert.equal((await request('/api/users/privateOwner', 'privateOwner')).body.user.followerCount, 1);

  update = await request('/api/users/profile', 'privateOwner', json('PUT', { profileVisibility: 'public' }));
  assert.equal(update.response.status, 200, JSON.stringify(update.body));
  assert.equal(relation('requester', 'privateOwner').status, 'accepted');
  assert.equal(relation('requester2', 'privateOwner').status, 'accepted');
  assert.equal(followNotificationCount('requester2', 'privateOwner'), 1);
  assert.equal((await request('/api/users/privateOwner', 'privateOwner')).body.user.followerCount, 2);
  assert.deepEqual((await request('/api/follows/requests', 'privateOwner')).body.requests, []);
});

test('blocking removes pending and accepted edges and unblocking never restores access', async () => {
  resetState();
  await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' });
  assert.equal(relation('requester', 'privateOwner').status, 'pending');
  await request(`/api/users/${ids.requester}/block`, 'privateOwner', { method: 'POST' });
  assert.equal(relation('requester', 'privateOwner'), undefined);
  assert.equal((await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' })).response.status, 404);
  await request(`/api/users/${ids.requester}/block`, 'privateOwner', { method: 'DELETE' });
  assert.equal(relation('requester', 'privateOwner'), undefined);

  await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' });
  await request(`/api/follows/requests/${ids.requester}/accept`, 'privateOwner', { method: 'POST' });
  assert.equal(followNotificationCount('requester', 'privateOwner'), 1);
  await request(`/api/users/${ids.privateOwner}/block`, 'requester', { method: 'POST' });
  assert.equal(relation('requester', 'privateOwner'), undefined);
  assert.equal(followNotificationCount('requester', 'privateOwner'), 0);
  await request(`/api/users/${ids.privateOwner}/block`, 'requester', { method: 'DELETE' });
  assert.equal(relation('requester', 'privateOwner'), undefined);
});

test('pending versus accepted viewers obey profile, feed, discovery, DM, and public-context rules', async () => {
  resetState();
  db.prepare('UPDATE users SET game_discovery_enabled = 1 WHERE id IN (?, ?)').run(ids.privateOwner, ids.requester);
  db.prepare("UPDATE users SET dm_privacy = 'friends' WHERE id = ?").run(ids.privateOwner);
  db.prepare("INSERT INTO follows (follower_id, following_id, status) VALUES (?, ?, 'accepted')").run(ids.privateOwner, ids.requester);

  const privatePost = addPost('privateOwner', 'PRIVATE PROFILE ONLY');
  const publicPost = addPost('publicTarget', 'PUBLIC THREAD');
  const comment = addPost('privateOwner', 'PRIVATE AUTHOR PUBLIC COMMENT', { parentId: publicPost });
  const repost = addPost('privateOwner', '', { repostOf: publicPost });
  const groupId = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)').run('PUBLIC GROUP', ids.groupOwner).lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(groupId, ids.groupOwner);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(groupId, ids.privateOwner);
  const groupPost = addPost('privateOwner', 'PRIVATE AUTHOR PUBLIC GROUP POST', { groupId });
  db.prepare("INSERT INTO post_media (post_id, media_type, url, mime_type) VALUES (?, 'image', '/uploads/batch11-public.png', 'image/png')").run(groupPost);
  const gameId = Number(db.prepare("INSERT INTO games (name, slug) VALUES ('Batch 11 Game', 'batch11-game')").run().lastInsertRowid);
  db.prepare("INSERT INTO user_game_preferences (user_id, game_id, display_on_profile) VALUES (?, ?, 1)").run(ids.privateOwner, gameId);
  db.prepare(`INSERT INTO game_lfg_posts (user_id, game_id, title, is_active, expires_at)
    VALUES (?, ?, 'PUBLIC LFG', 1, datetime('now', '+6 hours'))`).run(ids.privateOwner, gameId);

  await request(`/api/follows/${ids.privateOwner}`, 'requester', { method: 'POST' });
  assert.equal((await request('/api/users/privateOwner')).response.status, 404);
  assert.equal((await request('/api/users/privateOwner', 'requester')).body.user.limited, true);
  assert.equal((await request('/api/users/privateOwner', 'outsider')).body.user.limited, true);
  assert.equal((await request('/api/users/privateOwner', 'privateOwner')).body.user.bio, 'PRIVATE BIO');
  assert.equal((await request('/api/users/privateOwner', 'admin')).body.user.bio, 'PRIVATE BIO');
  assert.equal((await request(`/api/posts/${privatePost}`, 'requester')).response.status, 404);
  assert.equal((await request(`/api/posts/${repost}`, 'requester')).response.status, 404);
  assert.equal((await request(`/api/posts/${groupPost}`)).response.status, 200);
  assert.equal((await request(`/api/uploads/post/${groupPost}`)).body.media.length, 1);
  assert.ok((await request(`/api/comments/${publicPost}`)).body.comments.some((item: any) => item.id === comment));
  assert.ok((await request('/api/games/batch11-game/lfg')).body.posts.some((item: any) => item.title === 'PUBLIC LFG'));
  assert.equal((await request('/api/games/batch11-game', 'requester')).body.players.some((item: any) => item.user_id === ids.privateOwner), false);
  assert.equal((await request('/api/messages', 'requester', json('POST', { userId: ids.privateOwner }))).response.status, 403);
  const friendsFeedPending = await request('/api/feed?level=friends', 'requester');
  assert.equal(friendsFeedPending.body.posts.some((item: any) => item.id === privatePost), false);
  const communityPending = await request('/api/feed?level=everyone', 'requester');
  assert.equal(communityPending.body.posts.some((item: any) => item.id === groupPost), true);
  assert.equal(communityPending.body.posts.some((item: any) => item.id === privatePost || item.id === repost), false);

  await request(`/api/follows/requests/${ids.requester}/accept`, 'privateOwner', { method: 'POST' });
  assert.equal((await request('/api/users/privateOwner', 'requester')).body.user.bio, 'PRIVATE BIO');
  assert.equal((await request(`/api/posts/${privatePost}`, 'requester')).response.status, 200);
  assert.equal((await request(`/api/posts/${repost}`, 'requester')).response.status, 200);
  assert.equal((await request('/api/games/batch11-game', 'requester')).body.players.some((item: any) => item.user_id === ids.privateOwner), true);
  assert.equal((await request('/api/messages', 'requester', json('POST', { userId: ids.privateOwner }))).response.status, 201);
  assert.equal((await request('/api/feed?level=friends', 'requester')).body.posts.some((item: any) => item.id === privatePost), true);

  await request(`/api/users/${ids.blocked}/block`, 'privateOwner', { method: 'POST' });
  assert.equal((await request(`/api/posts/${groupPost}`, 'blocked')).response.status, 404);
  assert.equal((await request(`/api/comments/${publicPost}`, 'blocked')).body.comments.some((item: any) => item.id === comment), false);
  assert.equal((await request('/api/games/batch11-game/lfg', 'blocked')).body.posts.some((item: any) => item.title === 'PUBLIC LFG'), false);
});

test('group origin is named only when authorized and nested reposts cannot restore it', async () => {
  resetState();
  const groupName = 'BATCH 11 ORIGIN SECRET';
  const groupId = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)').run(groupName, ids.groupOwner).lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(groupId, ids.groupOwner);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(groupId, ids.privateOwner);
  const groupPost = addPost('privateOwner', 'PUBLIC GROUP POST', { groupId });

  let visible = await request(`/api/posts/${groupPost}`, 'outsider');
  assert.deepEqual(visible.body.post.group, { id: groupId, name: groupName });
  assert.equal(visible.body.post.groupId, groupId);
  assert.equal(visible.body.post.isGroupPost, true);

  await request(`/api/users/${ids.groupOwner}/block`, 'outsider', { method: 'POST' });
  visible = await request(`/api/posts/${groupPost}`, 'outsider');
  assert.equal(visible.response.status, 200);
  assert.equal(visible.body.post.group, null);
  assert.equal(visible.body.post.groupId, null);
  assert.equal(visible.body.post.isGroupPost, true);
  assert.equal(JSON.stringify(visible.body).includes(groupName), false);
  assert.equal(JSON.stringify(visible.body).includes(`\"groupId\":${groupId}`), false);

  const reposted = await request(`/api/reposts/${groupPost}`, 'publicTarget', { method: 'POST' });
  assert.equal(reposted.response.status, 201, JSON.stringify(reposted.body));
  const nested = await request(`/api/posts/${reposted.body.post.id}`, 'outsider');
  assert.equal(nested.response.status, 200);
  assert.equal(nested.body.post.repostedPost.isGroupPost, true);
  assert.equal(nested.body.post.repostedPost.group, null);
  assert.equal(nested.body.post.repostedPost.groupId, null);
  assert.equal(JSON.stringify(nested.body).includes(groupName), false);

  assert.equal((await request(`/api/groups/${groupId}`, 'groupOwner', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/posts/${groupPost}`, 'outsider')).response.status, 404);
  assert.equal((await request(`/api/posts/${reposted.body.post.id}`, 'outsider')).response.status, 404);
});
