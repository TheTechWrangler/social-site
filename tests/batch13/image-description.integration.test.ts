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
const JWT_SECRET = 'isolated-batch13-jwt-secret-not-for-production';

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
      SESSION_SECRET: 'isolated-batch13-session-secret-not-for-production',
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

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function upload() {
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'test.png');
  const response = await fetch(`${baseUrl}/api/uploads/image`, { method: 'POST', body: form, headers: { cookie: cookie('author'), origin: baseUrl } });
  assert.equal(response.status, 201);
  return (await response.json()).asset;
}
async function attach(assetId: string, postId: number, altText: unknown = '') {
  return request(`/api/uploads/assets/${assetId}/attach`, 'author', { method: 'POST', body: JSON.stringify({ postId, altText }) });
}
async function attached(altText = 'Original description', fields = {}) {
  const postId = addPost('author', 'Original text', fields);
  const asset = await upload();
  const result = await attach(asset.id, postId, altText);
  assert.equal(result.response.status, 201);
  return { postId, asset, media: result.body.media };
}

test('upload → strict attachment → canonical DB/API description, decorative empty and maximum length', async () => {
  for (const value of ['  A fox & <b>snow</b> "in winter"  ', '', '  ', 'x'.repeat(500)]) {
    const { postId, asset, media } = await attached(value);
    assert.equal(media.alt_text, value.trim());
    assert.equal((db.prepare('SELECT alt_text FROM post_media WHERE id = ?').get(media.id) as any).alt_text, value.trim());
    assert.equal((db.prepare('SELECT alt_text FROM managed_assets WHERE id = ?').get(asset.id) as any).alt_text, '');
    const fetched = await request(`/api/uploads/post/${postId}`, 'author');
    assert.equal(fetched.body.media[0].alt_text, value.trim());
    assert.equal(fetched.body.media[0].canEditAlt, true);
    assert.equal(fetched.body.media[0].attachment_key, undefined);
    assert.equal(fetched.body.media[0].storage_key, undefined);
  }
});

test('attachment rejects malformed description/body/unknown fields before activation', async () => {
  const postId = addPost('author', 'Attachment');
  const asset = await upload();
  for (const body of [null, [], {}, { postId, altText: null }, { postId, altText: true }, { postId, altText: 123 },
    { postId, altText: 'x'.repeat(501) }, { postId: String(postId) }, { postId, altText: '', ownerId: ids.outsider }]) {
    const result = await request(`/api/uploads/assets/${asset.id}/attach`, 'author', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(result.response.status, 400, JSON.stringify(body));
  }
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(asset.id) as any).state, 'pending');
  assert.equal((db.prepare('SELECT count(*) n FROM post_media').get() as any).n, 0);
  const legacy = await request(`/api/uploads/assets/${asset.id}/attach`, 'author', { method: 'POST', body: JSON.stringify({ postId }) });
  assert.equal(legacy.response.status, 201);
  assert.equal(legacy.body.media.alt_text, '');
});

test('response-loss and simultaneous attachment retries preserve one asset/relation and never overwrite later descriptions', async () => {
  const postId = addPost('author', 'Retry');
  const asset = await upload();
  const results = await Promise.all([attach(asset.id, postId, 'Chosen description'), attach(asset.id, postId, 'Chosen description')]);
  assert.deepEqual(results.map(r => r.response.status).sort(), [200, 201]);
  assert.equal(results[0].body.media.id, results[1].body.media.id);
  const mediaId = results[0].body.media.id;
  assert.equal((db.prepare('SELECT count(*) n FROM managed_assets').get() as any).n, 1);
  assert.equal((db.prepare('SELECT count(*) n FROM post_media').get() as any).n, 1);
  await request(`/api/uploads/media/${mediaId}/description`, 'author', patch({ altText: 'Revised' }));
  const replay = await attach(asset.id, postId, 'Old retry');
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.media.id, mediaId);
  assert.equal(replay.body.media.alt_text, 'Revised');
});

test('owner updates/clears description without touching post, asset identity, lifecycle, or physical bytes', async () => {
  const { postId, asset, media } = await attached();
  const assetBefore: any = db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(asset.id);
  const postBefore = storedPost(postId);
  const mediaBefore: any = db.prepare('SELECT * FROM post_media WHERE id = ?').get(media.id);
  const physical = path.join(uploadsDir, assetBefore.storage_key);
  const bytesBefore = fs.readFileSync(physical);
  for (const value of ['  Description & <script>not executable</script>  ', 'x'.repeat(500), '']) {
    const result = await request(`/api/uploads/media/${media.id}/description`, 'author', patch({ altText: value }));
    assert.equal(result.response.status, 200);
    assert.equal(result.body.media.alt_text, value.trim());
    assert.deepEqual(storedPost(postId), postBefore);
    assert.deepEqual(db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(asset.id), assetBefore);
    assert.deepEqual(db.prepare('SELECT * FROM post_media WHERE id = ?').get(media.id), { ...mediaBefore, alt_text: value.trim() });
    assert.deepEqual(fs.readFileSync(physical), bytesBefore);
  }
});

test('description edit is strict and owner-only, not a group or administrative privilege', async () => {
  const groupId = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)').run('Public group', ids.groupOwner).lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(groupId, ids.groupAdmin);
  const { postId, media } = await attached('Unchanged', { groupId });
  const url = `/api/uploads/media/${media.id}/description`;
  for (const actor of ['outsider','follower','groupOwner','groupAdmin','siteAdmin','moderator']) {
    assert.equal((await request(url, actor, patch({ altText: 'Wrong' }))).response.status, 404);
  }
  assert.equal((await request(url, undefined, patch({ altText: 'Wrong' }))).response.status, 401);
  for (const body of [null, [], {}, { altText: null }, { altText: false }, { altText: 'x'.repeat(501) },
    ...['postId','groupId','parentId','repostId','assetId','url','hidden','editVersion','userId','alt_text'].map(key => ({ altText: '', [key]: 1 }))]) {
    assert.equal((await request(url, 'author', patch(body))).response.status, 400);
  }
  assert.equal((await request('/api/uploads/media/999999/description', 'author', patch({ altText: '' }))).response.status, 404);
  db.prepare('UPDATE users SET is_verified = 0 WHERE id = ?').run(ids.author);
  assert.equal((await request(url, 'author', patch({ altText: '' }))).response.status, 403);
  db.prepare('UPDATE users SET is_verified = 1, banned = 1 WHERE id = ?').run(ids.author);
  assert.equal((await request(url, 'author', patch({ altText: '' }))).response.status, 403);
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(ids.author);
  db.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(postId);
  assert.equal((await request(url, 'author', patch({ altText: '' }))).response.status, 404);
  db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
  assert.equal((await request(url, 'author', patch({ altText: '' }))).response.status, 404);
});

test('current visibility blocks inaccessible reply media and private descriptions while preserving public group context', async () => {
  const parentId = addPost('outsider', 'Parent');
  const { postId, media } = await attached('Reply image', { parentId });
  db.prepare("INSERT INTO user_relationship_blocks (blocker_user_id, blocked_user_id, relationship_type) VALUES (?, ?, 'block')").run(ids.outsider, ids.author);
  assert.equal((await request(`/api/uploads/media/${media.id}/description`, 'author', patch({ altText: 'No' }))).response.status, 404);
  assert.equal((await request(`/api/uploads/post/${postId}`, 'author')).response.status, 404);
  db.prepare('DELETE FROM user_relationship_blocks').run();
  db.prepare("UPDATE users SET profile_visibility = 'private' WHERE id = ?").run(ids.author);
  const ordinary = await attached('Private description');
  assert.equal((await request(`/api/uploads/post/${ordinary.postId}`, 'outsider')).response.status, 404);
  const groupId = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)').run('Public context', ids.groupOwner).lastInsertRowid);
  const groupImage = await attached('Public description', { groupId });
  const fetched = await request(`/api/uploads/post/${groupImage.postId}`, 'outsider');
  assert.equal(fetched.body.media[0].alt_text, 'Public description');
  assert.equal(fetched.body.media[0].canEditAlt, false);
  assert.equal((await request(`/api/uploads/media/${groupImage.media.id}/description`, 'author', patch({ altText: 'Still public' }))).response.status, 200);
  assert.equal(storedPost(groupImage.postId).group_id, groupId);
});

test('Batch 12 text concurrency stays independent from image descriptions', async () => {
  const { postId, media } = await attached('Image description');
  const edit = await request(`/api/posts/${postId}`, 'author', patch({ content: 'Text version one', expectedEditVersion: 0 }));
  assert.equal(edit.response.status, 200);
  assert.equal((db.prepare('SELECT alt_text FROM post_media WHERE id = ?').get(media.id) as any).alt_text, 'Image description');
  await request(`/api/uploads/media/${media.id}/description`, 'author', patch({ altText: 'New description' }));
  const stale = await request(`/api/posts/${postId}`, 'author', patch({ content: 'Stale text', expectedEditVersion: 0 }));
  assert.equal(stale.response.status, 409);
  assert.equal(storedPost(postId).content, 'Text version one');
  assert.equal(storedPost(postId).edit_version, 1);
  assert.equal((db.prepare('SELECT alt_text FROM post_media WHERE id = ?').get(media.id) as any).alt_text, 'New description');
});

test('a controlled description-write failure rolls back without changing text/media/assets', async () => {
  const { postId, asset, media } = await attached('Original description');
  const mediaBefore = db.prepare('SELECT * FROM post_media WHERE id = ?').get(media.id);
  const assetBefore = db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(asset.id);
  const postBefore = storedPost(postId);
  db.exec("CREATE TRIGGER batch13_fail_description AFTER UPDATE OF alt_text ON post_media BEGIN SELECT RAISE(ABORT, 'controlled failure'); END");
  try {
    const result = await request(`/api/uploads/media/${media.id}/description`, 'author', patch({ altText: 'Must roll back' }));
    assert.equal(result.response.status, 500);
    assert.deepEqual(db.prepare('SELECT * FROM post_media WHERE id = ?').get(media.id), mediaBefore);
    assert.deepEqual(db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(asset.id), assetBefore);
    assert.deepEqual(storedPost(postId), postBefore);
  } finally { db.exec('DROP TRIGGER batch13_fail_description'); }
});

test('staged upload rejects unknown metadata without creating a durable asset or leaving an upload', async () => {
  const beforeFiles = fs.readdirSync(uploadsDir).sort();
  const form = new FormData();
  form.append('file', new Blob([PNG], { type: 'image/png' }), 'test.png');
  form.append('altText', 'Descriptions belong to the final attachment');
  const result = await fetch(`${baseUrl}/api/uploads/image`, { method: 'POST', body: form, headers: { cookie: cookie('author'), origin: baseUrl } });
  assert.equal(result.status, 400);
  assert.equal((db.prepare('SELECT count(*) n FROM managed_assets').get() as any).n, 0);
  assert.deepEqual(fs.readdirSync(uploadsDir).sort(), beforeFiles);
});

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch13-'));
  databasePath = path.join(testRoot, 'data', 'batch13.db');
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
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-batch13-'))) {
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
