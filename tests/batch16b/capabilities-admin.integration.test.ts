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
const JWT_SECRET = 'isolated-batch16b-jwt-secret';
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
      if (!address || typeof address === 'string') return reject(new Error('No test port.'));
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function cookie(id: number): string {
  const row = db.prepare('SELECT id, username, role, is_verified FROM users WHERE id = ?').get(id) as any;
  return `refugecloud_auth=${jwt.sign(row, JWT_SECRET, { expiresIn: '10m' })}`;
}

async function request(pathname: string, options: RequestInit = {}, userId?: number) {
  const headers = new Headers(options.headers);
  if (userId) headers.set('cookie', cookie(userId));
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('origin', baseUrl);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(baseUrl + pathname, { redirect: 'manual', ...options, headers });
  const body = (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch16b-'));
  databasePath = path.join(root, 'data', 'batch16b.db');
  uploadsDir = path.join(root, 'uploads');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', PORT: String(port),
      DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir, JWT_SECRET,
      SESSION_SECRET: 'isolated-batch16b-session-secret', APP_BASE_URL: baseUrl, WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', STEAM_API_KEY: '', STEAM_RETURN_URL: '',
      RESEND_API_KEY: '', RATE_LIMIT_ENABLED: 'false', ENABLE_IMAGE_UPLOADS: 'false',
      ENABLE_EXTERNAL_VIDEO_EMBEDS: 'false', ENABLE_VIDEO_UPLOADS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(baseUrl + '/api/health')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!server || server.exitCode !== null) throw new Error(serverLog);
  db = new Database(databasePath);
  db.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, is_verified)
    VALUES (1, 'adminb', 'Admin', 'admin@test.invalid', 'local-hash', 'admin', 1)`).run();
  db.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, is_verified)
    VALUES (2, 'oauthonly', 'OAuth', 'oauth@test.invalid', '', 'user', 1)`).run();
  db.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, is_verified)
    VALUES (3, 'mixedauth', 'Mixed', 'mixed@test.invalid', 'local-hash', 'user', 1)`).run();
  db.prepare(`INSERT INTO users (id, username, display_name, email, password_hash, role, is_verified)
    VALUES (4, 'unverified', 'Unverified', 'unverified@test.invalid', 'local-hash', 'user', 0)`).run();
  db.prepare(`INSERT INTO user_auth_providers
    (user_id, provider, provider_user_id, provider_email, provider_display_name, provider_avatar_url)
    VALUES (?, 'google', ?, '', '', '')`).run(2, 'oauth-2');
  db.prepare(`INSERT INTO user_auth_providers
    (user_id, provider, provider_user_id, provider_email, provider_display_name, provider_avatar_url)
    VALUES (?, 'google', ?, '', '', '')`).run(3, 'oauth-3');
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server!.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('disabled image, avatar, embed, and direct-video capabilities are explicit and non-cacheable', async () => {
  const result = await request('/api/uploads/capabilities');
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(result.body, {
    imageUploads: { enabled: false, reason: 'Image uploads are currently unavailable.' },
    avatarUploads: { enabled: false, reason: 'Avatar uploads are currently unavailable.' },
    externalVideoEmbeds: { enabled: false, reason: 'YouTube embeds are currently unavailable.' },
    directVideoUploads: { enabled: false, reason: 'Direct video upload is unavailable.' },
  });
});

test('authoritative backend still rejects disabled media when client capability state is stale', async () => {
  const image = await request('/api/uploads/image', { method: 'POST' }, 3);
  assert.equal(image.response.status, 403);
  assert.match(image.body.error, /disabled/);
  const avatar = await request('/api/uploads/avatar', { method: 'POST' }, 3);
  assert.equal(avatar.response.status, 403);
  const embed = await request('/api/uploads/external-video', {
    method: 'POST', body: JSON.stringify({ url: 'https://youtu.be/dQw4w9WgXcQ', postId: 1, attachmentKey: 'abcdefghijklmnop' }),
  }, 3);
  assert.equal(embed.response.status, 403);
});

test('admin reset eligibility is server-computed for OAuth-only, local, and mixed accounts', async () => {
  const users = await request('/api/admin/users', {}, 1);
  assert.equal(users.response.status, 200);
  const byId = new Map(users.body.users.map((user: any) => [user.id, user]));
  assert.equal(byId.get(2).can_generate_password_reset, 0);
  assert.equal(byId.get(3).can_generate_password_reset, 1);
  assert.equal(byId.get(2).password_hash, undefined);

  const oauthActivity = await request('/api/admin/users/2/activity', {}, 1);
  const mixedActivity = await request('/api/admin/users/3/activity', {}, 1);
  assert.equal(oauthActivity.body.user.can_generate_password_reset, 0);
  assert.equal(mixedActivity.body.user.can_generate_password_reset, 1);
  assert.equal((await request('/api/admin/users/2/password-reset-token', { method: 'POST' }, 1)).response.status, 400);
  assert.equal((await request('/api/admin/users/3/password-reset-token', { method: 'POST' }, 1)).response.status, 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM operational_audit WHERE event_type = 'user.reset_issued'").get() as any).count, 1);
});

test('generic auth responses remain non-enumerating and do not guarantee delivery', async () => {
  const absent = await request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ emailOrUsername: 'absent' }) });
  const existing = await request('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify({ emailOrUsername: 'mixedauth' }) });
  assert.equal(absent.response.status, 200);
  assert.deepEqual(absent.body, existing.body);
  assert.doesNotMatch(existing.body.message, /has been sent/i);
  const resend = await request('/api/auth/resend-verification', { method: 'POST' }, 4);
  assert.equal(resend.response.status, 200);
  assert.match(resend.body.message, /If verification is still needed and email delivery is available/);
  assert.doesNotMatch(resend.body.message, /sent/i);
});
