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
const JWT_SECRET = 'isolated-batch12-jwt-secret-not-for-production';

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
      SESSION_SECRET: 'isolated-batch12-session-secret-not-for-production',
      APP_BASE_URL: baseUrl, WEB_BASE_URL: baseUrl, GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '', STEAM_API_KEY: '', STEAM_RETURN_URL: '',
      RESEND_API_KEY: '', RATE_LIMIT_ENABLED: 'false',
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

function patch(body: unknown): RequestInit {
  return { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

function addPost(owner: string, content: string, fields: { groupId?: number; parentId?: number; repostOf?: number; hidden?: boolean } = {}): number {
  return Number(db.prepare(`
    INSERT INTO posts (user_id, content, group_id, parent_id, repost_of, hidden)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    ids[owner], content, fields.groupId ?? null, fields.parentId ?? null,
    fields.repostOf ?? null, fields.hidden ? 1 : 0,
  ).lastInsertRowid);
}

function storedPost(postId: number): any {
  return db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch12-'));
  databasePath = path.join(testRoot, 'data', 'batch12.db');
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
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-batch12-'))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to clean unexpected test path: ${testRoot}`);
  }
});

beforeEach(() => {
  db.exec(`
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

test('legacy post migration preserves identity/content and is repeat-safe after edits', async () => {
  await stopServer();
  const legacyId = addPost('author', 'Legacy post');
  const legacy = storedPost(legacyId);
  db.exec('ALTER TABLE posts DROP COLUMN edited_at; ALTER TABLE posts DROP COLUMN edit_version;');
  db.close();
  await startServer();
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  assert.deepEqual(storedPost(legacyId), legacy);
  const edit = await request(`/api/posts/${legacyId}`, 'author', patch({ content: 'Edited legacy', expectedEditVersion: 0 }));
  assert.equal(edit.response.status, 200);
  const edited = storedPost(legacyId);
  await stopServer();
  db.close();
  await startServer();
  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  assert.deepEqual(storedPost(legacyId), edited);
});

test('post edit schema starts posts unedited and owner-only authorization is privacy preserving', async () => {
  const columns = db.prepare('PRAGMA table_info(posts)').all() as any[];
  assert.ok(columns.some(column => column.name === 'edited_at'));
  assert.ok(columns.some(column => column.name === 'edit_version'));
  const postId = addPost('author', 'original');
  assert.equal(storedPost(postId).edited_at, null);
  assert.equal(storedPost(postId).edit_version, 0);

  db.prepare("INSERT INTO follows (follower_id, following_id, status) VALUES (?, ?, 'accepted')").run(ids.follower, ids.author);
  for (const actor of [undefined, 'outsider', 'follower', 'groupOwner', 'groupAdmin', 'siteAdmin', 'moderator']) {
    const result = await request(`/api/posts/${postId}`, actor, patch({ content: 'unauthorized', expectedEditVersion: 0 }));
    assert.equal(result.response.status, actor ? 404 : 401, String(actor));
  }
  assert.equal(storedPost(postId).content, 'original');

  const owner = await request(`/api/posts/${postId}`, 'author', patch({ content: '  owner edit  ', expectedEditVersion: 0 }));
  assert.equal(owner.response.status, 200);
  assert.equal(owner.body.post.content, 'owner edit');
  assert.equal(owner.body.post.editVersion, 1);
  assert.ok(owner.body.post.editedAt);
  assert.equal(owner.body.post.canEdit, true);
  assert.equal((await request(`/api/posts/${postId}`, 'siteAdmin')).body.post.canEdit, false);
  db.prepare('UPDATE users SET is_verified = 0 WHERE id = ?').run(ids.author);
  assert.equal((await request(`/api/posts/${postId}`, 'author')).body.post.canEdit, false);
  assert.equal((await request(`/api/posts/${postId}`, 'author', patch({ content: 'denied', expectedEditVersion: 1 }))).response.status, 403);
  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(ids.author);
  assert.equal((await request(`/api/posts/${postId}`, 'author', patch({ content: 'denied', expectedEditVersion: 1 }))).response.status, 403);
});

test('PATCH validates exact shape, content bounds, immutable fields, and expected version', async () => {
  const postId = addPost('author', 'unchanged');
  const invalidBodies: unknown[] = [
    null, [], {}, { content: '', expectedEditVersion: 0 }, { content: '   ', expectedEditVersion: 0 },
    { content: null, expectedEditVersion: 0 }, { content: {}, expectedEditVersion: 0 },
    { content: [], expectedEditVersion: 0 },
    { content: 'x'.repeat(5001), expectedEditVersion: 0 },
    { content: 123, expectedEditVersion: 0 }, { content: 'valid' },
    { content: 'valid', expectedEditVersion: false },
    ...[null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER].map(version => ({ content: 'valid', expectedEditVersion: version })),
  ];
  for (const body of invalidBodies) {
    const result = await request(`/api/posts/${postId}`, 'author', patch(body));
    assert.equal(result.response.status, 400, JSON.stringify(body)?.slice(0, 80));
  }
  for (const key of ['userId', 'groupId', 'parentId', 'repostId', 'repostOf', 'media', 'assetId', 'hidden', 'createdAt', 'editVersion', 'editedAt', 'user_id', 'group_id', 'parent_id', 'repost_of', 'moderation', 'visibility']) {
    const result = await request(`/api/posts/${postId}`, 'author', patch({ content: 'valid', expectedEditVersion: 0, [key]: 1 }));
    assert.equal(result.response.status, 400, key);
    assert.match(result.body.error, /Unknown field/);
  }
  assert.equal(storedPost(postId).content, 'unchanged');
  assert.equal(storedPost(postId).edit_version, 0);
  const malformed = await request(`/api/posts/${postId}`, 'author', {
    method: 'PATCH', body: '{', headers: { 'content-type': 'application/json' },
  });
  assert.equal(malformed.response.status, 400);
  const tooLarge = await request(`/api/posts/${postId}`, 'author', patch({ content: 'x'.repeat(70000), expectedEditVersion: 0 }));
  assert.equal(tooLarge.response.status, 413);
  const maxPost = addPost('author', 'short');
  const maximum = await request(`/api/posts/${maxPost}`, 'author', patch({ content: 'x'.repeat(5000), expectedEditVersion: 0 }));
  assert.equal(maximum.response.status, 200);
  assert.equal(storedPost(maxPost).content.length, 5000);
});

test('create, comment and edit text share runtime types, trimming and length limits', async () => {
  const parent = addPost('author', 'Parent');
  for (const content of ['', '  ', null, 42, {}, [], 'x'.repeat(5001)]) {
    for (const route of ['/api/posts', `/api/comments/${parent}`]) {
      const result = await request(route, 'author', { method: 'POST', body: JSON.stringify({ content }) });
      assert.equal(result.response.status, 400, `${route}: ${JSON.stringify(content).slice(0, 25)}`);
    }
  }
  const created = await request('/api/posts', 'author', { method: 'POST', body: JSON.stringify({ content: '  new text  ' }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.post.content, 'new text');
  assert.equal(created.body.post.editVersion, 0);
  assert.equal(created.body.post.editedAt, null);
  const noop = await request(`/api/posts/${created.body.post.id}`, 'author', patch({ content: ' new text ', expectedEditVersion: 0 }));
  assert.equal(noop.body.changed, false);
  assert.equal(noop.body.post.editedAt, null);
  assert.equal(noop.body.post.editVersion, 0);
});

test('profile, group, and reply text are editable while context and repost/hidden/deleted states are protected', async () => {
  const groupId = Number(db.prepare(
    'INSERT INTO groups_table (name, owner_id) VALUES (?, ?)',
  ).run('Public Group', ids.groupOwner).lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(groupId, ids.author);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(groupId, ids.groupAdmin);

  const profilePost = addPost('author', 'profile');
  const groupPost = addPost('author', 'group', { groupId });
  const reply = addPost('author', 'reply', { parentId: profilePost });
  for (const groupActor of ['groupOwner', 'groupAdmin']) {
    const denied = await request(`/api/posts/${groupPost}`, groupActor, patch({ content: 'role rewrite', expectedEditVersion: 0 }));
    assert.equal(denied.response.status, 404, groupActor);
  }
  for (const [postId, content] of [[profilePost, 'profile edited'], [groupPost, 'group edited'], [reply, 'reply edited']] as const) {
    const before = storedPost(postId);
    const result = await request(`/api/posts/${postId}`, 'author', patch({ content, expectedEditVersion: 0 }));
    assert.equal(result.response.status, 200);
    const after = storedPost(postId);
    assert.equal(after.content, content);
    assert.equal(after.user_id, before.user_id);
    assert.equal(after.group_id, before.group_id);
    assert.equal(after.parent_id, before.parent_id);
    assert.equal(after.repost_of, before.repost_of);
    assert.equal(after.created_at, before.created_at);
  }
  const groupDto = await request(`/api/posts/${groupPost}`, 'author');
  assert.deepEqual(groupDto.body.post.group, { id: groupId, name: 'Public Group' });
  db.prepare("UPDATE users SET profile_visibility = 'private' WHERE id = ?").run(ids.author);
  assert.equal((await request(`/api/posts/${profilePost}`)).response.status, 404);
  const publicGroupDto = await request(`/api/posts/${groupPost}`);
  assert.equal(publicGroupDto.response.status, 200);
  assert.deepEqual(publicGroupDto.body.post.group, { id: groupId, name: 'Public Group' });

  const wrapper = addPost('author', '', { repostOf: profilePost });
  assert.equal((await request(`/api/posts/${wrapper}`, 'author', patch({ content: 'masquerade', expectedEditVersion: 0 }))).response.status, 409);
  assert.equal(storedPost(wrapper).content, '');
  const hidden = addPost('author', 'moderated', { hidden: true });
  assert.equal((await request(`/api/posts/${hidden}`, 'author', patch({ content: 'reactivate', expectedEditVersion: 0 }))).response.status, 404);
  assert.equal(storedPost(hidden).hidden, 1);
  const deleted = addPost('author', 'deleted');
  db.prepare('DELETE FROM posts WHERE id = ?').run(deleted);
  assert.equal((await request(`/api/posts/${deleted}`, 'author', patch({ content: 'restore', expectedEditVersion: 0 }))).response.status, 404);
});

test('no-op is stable and stale concurrent edits never overwrite the winner', async () => {
  const postId = addPost('author', 'version zero');
  const loadedA = (await request(`/api/posts/${postId}`, 'author')).body.post;
  const loadedB = (await request(`/api/posts/${postId}`, 'author')).body.post;
  assert.equal(loadedA.editVersion, 0);
  assert.equal(loadedB.editVersion, 0);
  assert.equal(loadedA.editedAt, null);

  const first = await request(`/api/posts/${postId}`, 'author', patch({ content: 'client A', expectedEditVersion: loadedA.editVersion }));
  assert.equal(first.response.status, 200);
  assert.equal(first.body.changed, true);
  assert.equal(first.body.post.editVersion, 1);

  const stale = await request(`/api/posts/${postId}`, 'author', patch({ content: 'client B draft', expectedEditVersion: loadedB.editVersion }));
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.code, 'STALE_POST_EDIT');
  assert.equal(storedPost(postId).content, 'client A');

  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await request(`/api/posts/${postId}`, 'author', patch({ content: 'version two', expectedEditVersion: 1 }));
  assert.equal(second.body.post.editVersion, 2);
  assert.ok(second.body.post.editedAt > first.body.post.editedAt);
  const beforeNoop = storedPost(postId);
  const noop = await request(`/api/posts/${postId}`, 'author', patch({ content: '  version two  ', expectedEditVersion: 2 }));
  assert.equal(noop.response.status, 200);
  assert.equal(noop.body.changed, false);
  const afterNoop = storedPost(postId);
  assert.equal(afterNoop.edit_version, 2);
  assert.equal(afterNoop.edited_at, beforeNoop.edited_at);
  assert.equal(afterNoop.created_at, beforeNoop.created_at);
});

test('editing image-post text preserves media identity, asset lifecycle, and physical bytes', async () => {
  const postId = addPost('author', '(image)');
  const assetId = 'a'.repeat(32);
  const filePath = path.join(uploadsDir, 'batch12-image.png');
  fs.writeFileSync(filePath, Buffer.from('batch12 image bytes'));
  db.prepare(`
    INSERT INTO managed_assets
      (id, owner_user_id, storage_key, url, media_type, mime_type, file_size_bytes,
       sha256, purpose, state, created_at_ms)
    VALUES (?, ?, ?, ?, 'image', 'image/png', ?, ?, 'post_image', 'active', ?)
  `).run(assetId, ids.author, 'batch12-image.png', '/uploads/batch12-image.png', 19, 'test-sha', Date.now());
  const mediaId = Number(db.prepare(`
    INSERT INTO post_media (post_id, asset_id, media_type, url, mime_type, file_size_bytes)
    VALUES (?, ?, 'image', '/uploads/batch12-image.png', 'image/png', 19)
  `).run(postId, assetId).lastInsertRowid);
  const mediaBefore = db.prepare('SELECT * FROM post_media WHERE id = ?').get(mediaId);
  const assetBefore = db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(assetId);
  const bytesBefore = fs.readFileSync(filePath);

  const result = await request(`/api/posts/${postId}`, 'author', patch({ content: 'image caption', expectedEditVersion: 0 }));
  assert.equal(result.response.status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM post_media WHERE id = ?').get(mediaId), mediaBefore);
  assert.deepEqual(db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(assetId), assetBefore);
  assert.deepEqual(fs.readFileSync(filePath), bytesBefore);
  const empty = await request(`/api/posts/${postId}`, 'author', patch({ content: '', expectedEditVersion: 1 }));
  assert.equal(empty.response.status, 400);
  assert.equal(storedPost(postId).content, 'image caption');
  assert.deepEqual(db.prepare('SELECT * FROM post_media WHERE id = ?').get(mediaId), mediaBefore);
  assert.deepEqual(db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(assetId), assetBefore);
});

test('open reports freeze text evidence; dismissed reports permit a later edit', async () => {
  const postId = addPost('author', 'reported evidence');
  const reported = await request('/api/reports', 'outsider', { method: 'POST', body: JSON.stringify({ targetType: 'post', targetId: postId, reason: 'Spam', details: 'test report evidence' }) });
  assert.equal(reported.response.status, 201);
  const reportId = (db.prepare('SELECT id FROM reports WHERE post_id = ?').get(postId) as any).id;
  assert.equal((await request(`/api/posts/${postId}`, 'author')).body.post.canEdit, false);
  const blocked = await request(`/api/posts/${postId}`, 'author', patch({ content: 'erase evidence', expectedEditVersion: 0 }));
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.code, 'POST_UNDER_REVIEW');
  assert.equal(storedPost(postId).content, 'reported evidence');
  assert.equal(storedPost(postId).edit_version, 0);
  const moderation = await request('/api/admin/reports', 'siteAdmin');
  assert.equal(moderation.body.reports.find((r: any) => r.id === reportId).post_content, 'reported evidence');
  assert.equal((await request(`/api/posts/${postId}`, 'author', patch({ content: 'reported evidence', expectedEditVersion: 0 }))).response.status, 409);

  await request(`/api/admin/reports/${reportId}`, 'siteAdmin', patch({ status: 'dismissed' }));
  const afterReview = await request(`/api/posts/${postId}`, 'author', patch({ content: 'after review', expectedEditVersion: 0 }));
  assert.equal(afterReview.response.status, 200);
  assert.equal(storedPost(postId).content, 'after review');
  await request(`/api/admin/reports/${reportId}`, 'siteAdmin', patch({ status: 'resolved' }));
  assert.equal((await request(`/api/posts/${postId}`, 'author', patch({ content: 'hidden edit', expectedEditVersion: 1 }))).response.status, 404);
});

test('reply edits fail closed for hidden, private, blocked or banned parent contexts', async () => {
  const parent = addPost('outsider', 'Parent');
  const reply = addPost('author', 'My reply', { parentId: parent });
  const edit = () => request(`/api/posts/${reply}`, 'author', patch({ content: 'inaccessible edit', expectedEditVersion: 0 }));
  db.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(parent);
  assert.equal((await edit()).response.status, 404);
  db.prepare('UPDATE posts SET hidden = 0 WHERE id = ?').run(parent);
  db.prepare("UPDATE users SET profile_visibility = 'private' WHERE id = ?").run(ids.outsider);
  assert.equal((await edit()).response.status, 404);
  db.prepare("UPDATE users SET profile_visibility = 'public', banned = 1 WHERE id = ?").run(ids.outsider);
  assert.equal((await edit()).response.status, 404);
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(ids.outsider);
  await request(`/api/users/${ids.outsider}/block`, 'author', { method: 'POST' });
  assert.equal((await edit()).response.status, 404);
  assert.equal(storedPost(reply).content, 'My reply');
  assert.equal(storedPost(reply).edit_version, 0);
});

test('private profile and public group context are preserved during edits and nested serialization', async () => {
  db.prepare("UPDATE users SET profile_visibility = 'private' WHERE id = ?").run(ids.author);
  const groupId = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)').run('Origin', ids.groupOwner).lastInsertRowid);
  const profileId = addPost('author', 'Private');
  const groupPostId = addPost('author', 'Public', { groupId });
  db.prepare("INSERT INTO follows (follower_id, following_id, status) VALUES (?, ?, 'accepted')").run(ids.follower, ids.author);
  for (const id of [profileId, groupPostId]) {
    const updated = await request(`/api/posts/${id}`, 'author', patch({ content: 'New text', expectedEditVersion: 0 }));
    assert.equal(updated.response.status, 200);
  }
  assert.equal((await request(`/api/posts/${profileId}`)).response.status, 404);
  assert.equal((await request(`/api/posts/${profileId}`, 'follower')).body.post.content, 'New text');
  assert.equal((await request(`/api/posts/${groupPostId}`)).body.post.content, 'New text');
  await request(`/api/users/${ids.groupOwner}/block`, 'author', { method: 'POST' });
  const edited = await request(`/api/posts/${groupPostId}`, 'author', patch({ content: 'Neutral origin', expectedEditVersion: 1 }));
  assert.equal(edited.response.status, 200);
  assert.equal(edited.body.post.group, null);
  assert.equal(edited.body.post.groupId, null);
  const wrapper = addPost('author', '', { repostOf: groupPostId });
  const nested = (await request(`/api/posts/${wrapper}`, 'author')).body.post.repostedPost;
  assert.equal(nested.content, 'Neutral origin');
  assert.equal(nested.group, null);
  assert.equal(nested.groupId, null);
});

test('a controlled database failure leaves text and edit metadata unchanged', async () => {
  const postId = addPost('author', 'Before failure');
  const before = storedPost(postId);
  db.exec(`CREATE TRIGGER batch12_fail AFTER UPDATE OF content ON posts BEGIN SELECT RAISE(ABORT, 'controlled edit failure'); END;`);
  try {
    const failed = await request(`/api/posts/${postId}`, 'author', patch({ content: 'must roll back', expectedEditVersion: 0 }));
    assert.equal(failed.response.status, 500);
    assert.deepEqual(storedPost(postId), before);
  } finally {
    db.exec('DROP TRIGGER batch12_fail');
  }
});
