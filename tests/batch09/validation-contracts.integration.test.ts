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
const JWT_SECRET = 'isolated-batch09-jwt-secret-not-for-production';

let testRoot = '';
let databasePath = '';
let baseUrl = '';
let server: ChildProcess | undefined;
let serverLog = '';
let db: Database.Database;
const userIds: Record<string, number> = {};
let gameId = 0;
let rssSourceId = 0;
let ownerLfgId = 0;
let unverifiedLfgId = 0;

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

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch09-'));
  databasePath = path.join(testRoot, 'data', 'batch09.db');
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
      SESSION_SECRET: 'isolated-batch09-session-secret-not-for-production',
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
  const insertUser = db.prepare(`
    INSERT INTO users (username, display_name, email, password_hash, role, is_verified)
    VALUES (?, ?, ?, 'test-only-hash', ?, ?)
  `);
  for (const [username, role, verified] of [
    ['admin', 'admin', 1],
    ['owner', 'user', 1],
    ['unverified', 'user', 0],
    ['outsider', 'user', 1],
  ] as const) {
    userIds[username] = Number(insertUser.run(username, username, `${username}@test.invalid`, role, verified).lastInsertRowid);
  }

  gameId = Number(db.prepare("INSERT INTO games (name, slug) VALUES ('Batch 09 Game', 'batch09-game')").run().lastInsertRowid);
  rssSourceId = Number(db.prepare(`
    INSERT INTO rss_sources (name, url, homepage_url, category, is_active)
    VALUES ('Original Source', 'https://feed.example.test/rss', 'https://example.test/', 'tech', 1)
  `).run().lastInsertRowid);
  const insertItem = db.prepare(`
    INSERT INTO rss_items (source_id, external_guid, title, link_url, item_type, published_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  insertItem.run(rssSourceId, 'article-guid', 'Article item', 'https://example.test/article', 'article');
  insertItem.run(rssSourceId, 'podcast-guid', 'Podcast item', 'https://example.test/podcast', 'podcast');

  const insertLfg = db.prepare(`
    INSERT INTO game_lfg_posts
      (user_id, game_id, title, body, platform, play_style, desired_group_size, mic_required, is_active, expires_at)
    VALUES (?, ?, ?, ?, 'PC', 'casual', ?, 0, ?, datetime('now', ?))
  `);
  ownerLfgId = Number(insertLfg.run(userIds.owner, gameId, 'Original title', 'Original body', 4, 1, '+6 hours').lastInsertRowid);
  unverifiedLfgId = Number(insertLfg.run(userIds.unverified, gameId, 'Old title', 'Old body', 3, 0, '-1 hour').lastInsertRowid);
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
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-batch09-'))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to clean unexpected test path: ${testRoot}`);
  }
});

test('RSS PATCH allowlists fields and never treats request keys as SQL identifiers', async () => {
  const valid = await request(`/api/admin/rss/sources/${rssSourceId}`, 'admin', json('PATCH', {
    name: '  Updated Source  ',
    homepageUrl: '',
    isActive: true,
  }));
  assert.equal(valid.response.status, 200, JSON.stringify(valid.body));
  const updated = db.prepare('SELECT * FROM rss_sources WHERE id = ?').get(rssSourceId) as any;
  assert.equal(updated.name, 'Updated Source');
  assert.equal(updated.homepage_url, '');
  assert.equal(updated.is_active, 1);
  assert.equal(updated.url, 'https://feed.example.test/rss');
  assert.equal(updated.category, 'tech');

  const rejectedBodies = [
    { unexpected: 'value' },
    { "name = 'owned', is_active": 0 },
    { id: 999 },
    { created_at: '2000-01-01' },
    { is_active: 0 },
    { name: 123 },
    { name: 'x'.repeat(121) },
    {},
  ];
  for (const body of rejectedBodies) {
    const result = await request(`/api/admin/rss/sources/${rssSourceId}`, 'admin', json('PATCH', body));
    assert.equal(result.response.status, 400, JSON.stringify({ body, response: result.body }));
  }
  const unchanged = db.prepare('SELECT name, url, category, is_active FROM rss_sources WHERE id = ?').get(rssSourceId) as any;
  assert.deepEqual(unchanged, {
    name: 'Updated Source',
    url: 'https://feed.example.test/rss',
    category: 'tech',
    is_active: 1,
  });
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rss_sources'").get());

  const unauthorized = await request(`/api/admin/rss/sources/${rssSourceId}`, 'owner', json('PATCH', { name: 'Nope' }));
  assert.equal(unauthorized.response.status, 403);
  const missing = await request('/api/admin/rss/sources/999999', 'admin', json('PATCH', { name: 'Missing' }));
  assert.equal(missing.response.status, 404);
});

test('LFG create and PATCH share strict trimming, bounds, null, boolean, and enum rules', async () => {
  const partial = await request(`/api/games/lfg/${ownerLfgId}`, 'owner', json('PATCH', { title: '  New title  ' }));
  assert.equal(partial.response.status, 200, JSON.stringify(partial.body));
  let row = db.prepare('SELECT * FROM game_lfg_posts WHERE id = ?').get(ownerLfgId) as any;
  assert.equal(row.title, 'New title');
  assert.equal(row.body, 'Original body');
  assert.equal(row.desired_group_size, 4);

  assert.equal((await request(`/api/games/lfg/${ownerLfgId}`, 'owner', json('PATCH', { desiredGroupSize: null }))).response.status, 200);
  row = db.prepare('SELECT * FROM game_lfg_posts WHERE id = ?').get(ownerLfgId) as any;
  assert.equal(row.desired_group_size, null);

  for (const micRequired of [true, false]) {
    const result = await request(`/api/games/lfg/${ownerLfgId}`, 'owner', json('PATCH', { micRequired }));
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    row = db.prepare('SELECT mic_required, typeof(mic_required) AS storage_type FROM game_lfg_posts WHERE id = ?').get(ownerLfgId) as any;
    assert.equal(row.mic_required, micRequired ? 1 : 0);
    assert.equal(row.storage_type, 'integer');
  }

  for (const body of [
    { title: '   ' },
    { title: null },
    { body: 'x'.repeat(1001) },
    { micRequired: 1 },
    { isActive: 1 },
    { desiredGroupSize: 0 },
    { play_style: 'casual' },
    {},
  ]) {
    const result = await request(`/api/games/lfg/${ownerLfgId}`, 'owner', json('PATCH', body));
    assert.equal(result.response.status, 400, JSON.stringify({ body, response: result.body }));
  }

  const created = await request('/api/games/batch09-game/lfg', 'owner', json('POST', {
    title: '  New listing  ',
    desiredGroupSize: 5,
    micRequired: true,
    durationHours: 6,
  }));
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.post.title, 'New listing');
  assert.equal(created.body.post.mic_required, 1);
  assert.equal((await request('/api/games/batch09-game/lfg', 'owner', json('POST', {
    title: 'Invalid duration', durationHours: 2,
  }))).response.status, 400);
  assert.equal((await request(`/api/games/lfg/${ownerLfgId}/extend`, 'owner', json('POST', {
    durationHours: 2,
  }))).response.status, 400);
});

test('unverified owners may clean up LFG data but cannot reactivate or extend it', async () => {
  const cleanup = await request(`/api/games/lfg/${unverifiedLfgId}`, 'unverified', json('PATCH', { body: '' }));
  assert.equal(cleanup.response.status, 200, JSON.stringify(cleanup.body));
  assert.equal((db.prepare('SELECT body FROM game_lfg_posts WHERE id = ?').get(unverifiedLfgId) as any).body, '');

  const reactivate = await request(`/api/games/lfg/${unverifiedLfgId}`, 'unverified', json('PATCH', { isActive: true }));
  assert.equal(reactivate.response.status, 403);
  assert.equal((db.prepare('SELECT is_active FROM game_lfg_posts WHERE id = ?').get(unverifiedLfgId) as any).is_active, 0);
  const extend = await request(`/api/games/lfg/${unverifiedLfgId}/extend`, 'unverified', json('POST', { durationHours: 6 }));
  assert.equal(extend.response.status, 403);
});

test('LFG mutations confirm affected rows and preserve owner privacy', async () => {
  const missing = await request('/api/games/lfg/999999', 'outsider', json('PATCH', { title: 'Nope' }));
  const unauthorized = await request(`/api/games/lfg/${ownerLfgId}`, 'outsider', json('PATCH', { title: 'Nope' }));
  assert.equal(missing.response.status, 404);
  assert.equal(unauthorized.response.status, 404);
  assert.deepEqual(unauthorized.body, missing.body);

  const temporaryId = Number(db.prepare(`
    INSERT INTO game_lfg_posts (user_id, game_id, title) VALUES (?, ?, 'Delete me')
  `).run(userIds.owner, gameId).lastInsertRowid);
  assert.equal((await request(`/api/games/lfg/${temporaryId}`, 'owner', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/games/lfg/${temporaryId}`, 'owner', { method: 'DELETE' })).response.status, 404);
});

test('admin game-server create/update use the canonical camelCase DTO', async () => {
  const created = await request('/api/admin/game-servers', 'admin', json('POST', {
    gameId,
    name: '  Canonical Server  ',
    connectionHost: 'game.example.test',
    connectionPort: 25565,
    platform: 'PC',
    status: 'online',
    maxPlayers: 20,
    currentPlayers: 3,
    isFeatured: true,
    isActive: false,
    serverType: 'community',
  }));
  assert.equal(created.response.status, 201, JSON.stringify(created.body));
  const serverId = created.body.server.id as number;
  let row = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(serverId) as any;
  assert.equal(row.name, 'Canonical Server');
  assert.equal(row.connection_host, 'game.example.test');
  assert.equal(row.connection_port, 25565);
  assert.equal(row.is_featured, 1);
  assert.equal(row.is_active, 0);

  const updated = await request(`/api/admin/game-servers/${serverId}`, 'admin', json('PATCH', {
    connectionHost: 'new.example.test', connectionPort: null, isActive: true, serverType: 'official',
  }));
  assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
  row = db.prepare('SELECT * FROM game_servers WHERE id = ?').get(serverId) as any;
  assert.equal(row.connection_host, 'new.example.test');
  assert.equal(row.connection_port, null);
  assert.equal(row.is_active, 1);
  assert.equal(row.server_type, 'official');

  assert.equal((await request(`/api/admin/game-servers/${serverId}`, 'admin', json('PATCH', { isActive: false }))).response.status, 200);
  assert.equal((db.prepare('SELECT is_active FROM game_servers WHERE id = ?').get(serverId) as any).is_active, 0);

  const defaults = await request('/api/admin/game-servers', 'admin', json('POST', { gameId, name: 'Defaults Server' }));
  assert.equal(defaults.response.status, 201, JSON.stringify(defaults.body));
  assert.equal(defaults.body.server.connection_port, null);
  assert.equal(defaults.body.server.max_players, null);
  assert.equal(defaults.body.server.current_players, 0);
  assert.equal(defaults.body.server.is_active, 1);
  assert.equal(defaults.body.server.status, 'unknown');

  for (const body of [
    { gameId, name: 'Snake', connection_host: 'old.example.test' },
    { gameId, name: 'Bad port', connectionPort: '25565' },
    { gameId, name: 'Bad port', connectionPort: 70000 },
    { gameId, name: 'Bad status', status: 'ready' },
    { gameId, name: 'Bad boolean', isActive: 0 },
  ]) {
    const result = await request('/api/admin/game-servers', 'admin', json('POST', body));
    assert.equal(result.response.status, 400, JSON.stringify({ body, response: result.body }));
  }
  assert.equal((await request(`/api/admin/game-servers/${serverId}`, 'admin', json('PATCH', { is_active: 1 }))).response.status, 400);
  assert.equal((await request(`/api/admin/game-servers/${serverId}`, 'owner', json('PATCH', { isActive: true }))).response.status, 403);
});

test('game-server mutations do not report success for nonexistent rows', async () => {
  assert.equal((await request('/api/admin/game-servers/999999', 'admin', json('PATCH', { name: 'Missing' }))).response.status, 404);
  const created = await request('/api/admin/game-servers', 'admin', json('POST', { gameId, name: 'Delete Server' }));
  const serverId = created.body.server.id as number;
  assert.equal((await request(`/api/admin/game-servers/${serverId}`, 'admin', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/admin/game-servers/${serverId}`, 'admin', { method: 'DELETE' })).response.status, 404);
});

test('World itemType reaches the query and rejects malformed values', async () => {
  const articles = await request('/api/world-feed?itemType=article');
  assert.equal(articles.response.status, 200);
  assert.ok(articles.body.items.length > 0);
  assert.ok(articles.body.items.every((item: any) => item.itemType === 'article'));
  assert.ok(articles.body.items.some((item: any) => item.title === 'Article item'));

  const podcasts = await request('/api/world-feed?itemType=podcast');
  assert.equal(podcasts.response.status, 200);
  assert.ok(podcasts.body.items.length > 0);
  assert.ok(podcasts.body.items.every((item: any) => item.itemType === 'podcast'));
  assert.ok(podcasts.body.items.some((item: any) => item.title === 'Podcast item'));
  assert.equal((await request('/api/world-feed?itemType=video')).response.status, 400);
  assert.equal((await request('/api/world-feed?itemType=article&itemType=podcast')).response.status, 400);
});

test('source block/unblock mutations have deterministic affected-row semantics', async () => {
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'owner', { method: 'POST' })).response.status, 200);
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'owner', { method: 'POST' })).response.status, 409);
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'outsider', { method: 'POST' })).response.status, 200);
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'outsider', { method: 'POST' })).response.status, 409);
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'unverified', { method: 'POST' })).response.status, 403);
  assert.equal((await request('/api/world-feed/sources/999999/block', 'owner', { method: 'POST' })).response.status, 404);
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'admin', { method: 'POST' })).response.status, 200);
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'admin', { method: 'POST' })).response.status, 409);
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'admin', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/world-feed/sources/${rssSourceId}/block`, 'admin', { method: 'DELETE' })).response.status, 404);
});
