import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const PRODUCTION_UPLOADS = path.join(PROJECT_ROOT, 'uploads');
const JWT_SECRET = 'isolated-security-jwt-secret-not-for-production';

let testRoot = '';
let databasePath = '';
let uploadsDir = '';
let baseUrl = '';
let server: ChildProcess | undefined;
let serverLog = '';
let db: Database.Database;

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
      const port = address.port;
      socket.close(error => error ? reject(error) : resolve(port));
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

function authCookie(user: { id: number; username: string; role?: string; verified?: number }): string {
  const token = jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role || 'user',
      is_verified: user.verified ?? 1,
    },
    JWT_SECRET,
    { expiresIn: '10m' },
  );
  return `refugecloud_auth=${token}`;
}

async function request(
  pathname: string,
  options: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
    headers,
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

function firstSetCookie(response: Response): string {
  const raw = response.headers.get('set-cookie');
  assert.ok(raw, 'expected a session cookie');
  return raw.split(';', 1)[0];
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-security-'));
  databasePath = path.join(testRoot, 'data', 'security.db');
  uploadsDir = path.join(testRoot, 'uploads');
  assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
  assert.notEqual(path.resolve(uploadsDir), path.resolve(PRODUCTION_UPLOADS));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  const port = await freePort();
  assert.notEqual(port, 3003);
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
      SESSION_SECRET: 'isolated-security-session-secret-not-for-production',
      APP_BASE_URL: baseUrl,
      WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: 'test-client-id-long-enough.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-google-secret',
      GOOGLE_CALLBACK_URL: `${baseUrl}/api/auth/google/callback`,
      STEAM_API_KEY: '',
      STEAM_RETURN_URL: '',
      RESEND_API_KEY: '',
      RATE_LIMIT_ENABLED: 'true',
      RATE_LIMIT_AUTH_MAX: '100',
      RATE_LIMIT_WRITE_MAX: '100',
      RATE_LIMIT_REPORT_MAX: '10',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  await waitForHealth();

  db = new Database(databasePath);
  const insertUser = db.prepare(
    `INSERT INTO users
      (username, display_name, email, password_hash, is_verified, profile_visibility, feed_exposure)
     VALUES (?, ?, ?, 'test-only-hash', ?, ?, 'everyone')`,
  );
  insertUser.run('owner', 'Owner', 'owner@test.invalid', 1, 'public');
  insertUser.run('reporter', 'Reporter', 'reporter@test.invalid', 1, 'public');
  insertUser.run('unverified', 'Unverified', 'unverified@test.invalid', 0, 'public');
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
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-security-'))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to clean unexpected test path: ${testRoot}`);
  }
});

test('Google OAuth initiation binds one-time state to the server session', async () => {
  const initiation = await request('/api/auth/google');
  assert.equal(initiation.response.status, 302);
  const location = initiation.response.headers.get('location');
  assert.ok(location);
  const state = new URL(location).searchParams.get('state');
  assert.match(state || '', /^[A-Za-z0-9_-]{43}$/);
  const cookie = firstSetCookie(initiation.response);

  const sessions = db.prepare('SELECT sess FROM sessions').all() as Array<{ sess: string }>;
  assert.ok(sessions.some(row => JSON.parse(row.sess).googleOAuthState?.value === state));

  const missing = await request('/api/auth/google/callback', {
    headers: { cookie },
  });
  assert.equal(missing.response.status, 302);
  assert.equal(missing.response.headers.get('location'), `${baseUrl}/login?error=google_failed`);

  const second = await request('/api/auth/google');
  const secondCookie = firstSetCookie(second.response);
  const mismatch = await request('/api/auth/google/callback?state=' + 'x'.repeat(43), {
    headers: { cookie: secondCookie },
  });
  assert.equal(mismatch.response.status, 302);
  assert.equal(mismatch.response.headers.get('location'), `${baseUrl}/login?error=google_failed`);

  const replay = await request('/api/auth/google/callback?state=' + 'x'.repeat(43), {
    headers: { cookie: secondCookie },
  });
  assert.equal(replay.response.status, 302);
  assert.equal(replay.response.headers.get('location'), `${baseUrl}/login?error=google_failed`);
});

test('Steam callback requires a session-bound login intent', async () => {
  const result = await request('/api/auth/steam/callback');
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get('location'), `${baseUrl}/login?error=steam_failed`);
});

test('password-reset and email-verification expiry parsing is UTC-safe', async () => {
  const user = db.prepare("SELECT id FROM users WHERE username = 'reporter'").get() as { id: number };
  const fixtures = [
    ['valid-legacy-token', '2999-01-01 00:00:00', 200],
    ['valid-iso-token', '2999-01-01T00:00:00.000Z', 200],
    ['expired-token', '2000-01-01 00:00:00', 400],
    ['malformed-token', 'not-a-time', 400],
  ] as const;
  const insert = db.prepare(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
  );
  for (const [token, expiresAt] of fixtures) insert.run(user.id, hashToken(token), expiresAt);

  for (const [token, , expectedStatus] of fixtures) {
    const result = await request(`/api/auth/reset-password?token=${token}`);
    assert.equal(result.response.status, expectedStatus, token);
  }

  db.prepare(
    'INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
  ).run(user.id, hashToken('malformed-email-token'), '2026-02-30 12:00:00');
  const malformedEmail = await request('/api/auth/verify-email?token=malformed-email-token');
  assert.equal(malformedEmail.response.status, 400);
});

test('reports enforce verification, visibility, deduplication, target validity, and throttling', async () => {
  const users = db.prepare('SELECT id, username FROM users').all() as Array<{ id: number; username: string }>;
  const byName = Object.fromEntries(users.map(user => [user.username, user]));
  const reporterCookie = authCookie({ ...byName.reporter });
  const unverifiedCookie = authCookie({ ...byName.unverified, verified: 0 });

  const insertPost = db.prepare('INSERT INTO posts (user_id, content, parent_id, hidden) VALUES (?, ?, ?, ?)');
  const postId = Number(insertPost.run(byName.owner.id, 'Reportable post', null, 0).lastInsertRowid);
  const otherPostId = Number(insertPost.run(byName.owner.id, 'Other post', null, 0).lastInsertRowid);
  const hiddenPostId = Number(insertPost.run(byName.owner.id, 'Hidden post', null, 1).lastInsertRowid);
  const commentId = Number(insertPost.run(byName.owner.id, 'Reportable comment', postId, 0).lastInsertRowid);
  const ownPostId = Number(insertPost.run(byName.reporter.id, 'Own post', null, 0).lastInsertRowid);
  const payload = (targetType: string, targetId: number) => JSON.stringify({
    targetType,
    targetId,
    reason: 'Spam',
    details: 'Security integration test report.',
  });

  const unauthenticated = await request('/api/reports', {
    method: 'POST',
    body: payload('post', postId),
  });
  assert.equal(unauthenticated.response.status, 401);

  const unverified = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: unverifiedCookie },
    body: payload('post', postId),
  });
  assert.equal(unverified.response.status, 403);

  const invalidType = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('user', postId),
  });
  assert.equal(invalidType.response.status, 400);

  const missing = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('post', 999999),
  });
  assert.equal(missing.response.status, 404);

  const mismatchedType = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('comment', otherPostId),
  });
  assert.equal(mismatchedType.response.status, 404);
  assert.deepEqual(mismatchedType.body, missing.body);

  const reported = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('post', postId),
  });
  assert.equal(reported.response.status, 201);

  const duplicate = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('post', postId),
  });
  assert.equal(duplicate.response.status, 409);
  const count = db.prepare(
    "SELECT COUNT(*) AS count FROM reports WHERE reporter_id = ? AND post_id = ? AND status = 'open'",
  ).get(byName.reporter.id, postId) as { count: number };
  assert.equal(count.count, 1);

  const comment = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('comment', commentId),
  });
  assert.equal(comment.response.status, 201);

  const hidden = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('post', hiddenPostId),
  });
  assert.equal(hidden.response.status, 404);
  assert.deepEqual(hidden.body, missing.body);

  db.prepare('UPDATE posts SET hidden = 1 WHERE id = ?').run(postId);
  const hiddenParent = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('comment', commentId),
  });
  assert.equal(hiddenParent.response.status, 404);
  assert.deepEqual(hiddenParent.body, missing.body);

  const own = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('post', ownPostId),
  });
  assert.equal(own.response.status, 400);

  const tenth = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('post', 999998),
  });
  assert.equal(tenth.response.status, 404);

  const throttled = await request('/api/reports', {
    method: 'POST',
    headers: { cookie: reporterCookie },
    body: payload('post', 999997),
  });
  assert.equal(throttled.response.status, 429);

});
