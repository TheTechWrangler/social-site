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
const JWT_SECRET = 'isolated-batch16-jwt-secret-not-for-production';

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server?.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Isolated server failed to start:\n${serverLog.slice(-8000)}`);
}

function cookie(userId: number): string {
  const user = db.prepare('SELECT id, username, role, is_verified FROM users WHERE id = ?').get(userId) as any;
  return `refugecloud_auth=${jwt.sign(user, JWT_SECRET, { expiresIn: '10m' })}`;
}

async function request(pathname: string, options: RequestInit = {}, userId?: number) {
  const headers = new Headers(options.headers);
  if (userId) headers.set('cookie', cookie(userId));
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('origin', baseUrl);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${baseUrl}${pathname}`, { redirect: 'manual', ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch16-integration-'));
  databasePath = path.join(root, 'data', 'telemetry.db');
  uploadsDir = path.join(root, 'uploads');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  assert.notEqual(databasePath, PRODUCTION_DB);

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DOTENV_CONFIG_PATH: '/dev/null',
      DATABASE_PATH: databasePath,
      UPLOADS_DIR: uploadsDir,
      PORT: String(port),
      JWT_SECRET,
      SESSION_SECRET: 'isolated-batch16-session-secret-not-for-production',
      APP_BASE_URL: baseUrl,
      WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      STEAM_API_KEY: '',
      STEAM_RETURN_URL: '',
      RESEND_API_KEY: '',
      RATE_LIMIT_ENABLED: 'false',
      TELEMETRY_CLEANUP_INTERVAL_MINUTES: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  await waitForHealth();

  db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.prepare(`
    INSERT INTO users (id, username, display_name, email, password_hash, role, is_verified)
    VALUES (1, 'admin16', 'Admin Sixteen', 'admin16@test.invalid', 'fixture', 'admin', 1)
  `).run();
  db.prepare(`
    INSERT INTO users (id, username, display_name, email, password_hash, role, is_verified)
    VALUES (2, 'member16', 'Member Sixteen', 'member16@test.invalid', 'fixture', 'user', 1)
  `).run();
  db.prepare(`
    INSERT INTO user_auth_providers
      (user_id, provider, provider_user_id, provider_email, provider_display_name, provider_avatar_url)
    VALUES (2, 'google', 'provider-16', 'provider-secret@test.invalid', 'Provider Secret', 'https://private.test/avatar')
  `).run();
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => server!.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('usage endpoint canonicalizes routes and ignores client-provided identity', async () => {
  const anonymous = await request('/api/usage/event', {
    method: 'POST',
    body: JSON.stringify({
      eventType: 'page_view',
      userId: 1,
      route: '/profile/private%40example.com?token=top-secret#fragment',
      featureArea: 'private-area',
      errorCode: 'TOKEN_top-secret',
      metadata: { email: 'private@example.com' },
    }),
  });
  assert.equal(anonymous.response.status, 200);

  const authenticated = await request('/api/usage/event', {
    method: 'POST',
    body: JSON.stringify({
      eventType: 'client_error',
      userId: 1,
      route: '/unlisted/private@example.com/top-secret',
      featureArea: 'profile',
      errorCode: 'UNHANDLED_ERROR',
    }),
  }, 2);
  assert.equal(authenticated.response.status, 200);

  const rows = db.prepare(`
    SELECT event_type, user_id, route, feature_area, error_code, metadata_json
    FROM usage_events ORDER BY id DESC LIMIT 2
  `).all().reverse() as any[];
  assert.deepEqual(rows[0], {
    event_type: 'page_view', user_id: null, route: '/profile/:username',
    feature_area: null, error_code: null, metadata_json: null,
  });
  assert.deepEqual(rows[1], {
    event_type: 'client_error', user_id: 2, route: '/other',
    feature_area: 'profile', error_code: 'UNHANDLED_ERROR', metadata_json: null,
  });
  assert.doesNotMatch(JSON.stringify(rows), /private%40|private@example|top-secret/);
});

test('failed login telemetry never stores the attempted identity', async () => {
  const attemptedIdentity = 'victim@example.com?token=top-secret';
  const result = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'user-agent': 'Batch16A Test Browser' },
    body: JSON.stringify({ username: attemptedIdentity, password: 'not-the-password' }),
  });
  assert.equal(result.response.status, 401);
  const row = db.prepare(`
    SELECT user_id, event_type, reason, user_agent, meta
    FROM auth_events WHERE event_type = 'login_failure' ORDER BY id DESC LIMIT 1
  `).get() as any;
  assert.deepEqual(row, {
    user_id: null,
    event_type: 'login_failure',
    reason: 'INVALID_CREDENTIALS',
    user_agent: 'Batch16A Test Browser',
    meta: '',
  });
  assert.doesNotMatch(JSON.stringify(row), /victim|top-secret/);
});

test('sensitive admin telemetry and status responses are explicit and non-cacheable', async () => {
  db.prepare(`
    INSERT INTO auth_events
      (user_id, event_type, success, reason, ip_address, user_agent, admin_actor_id, target_user_id, meta)
    VALUES (2, 'admin_role_change', 1, '', '127.0.0.1', 'Fixture Agent', 1, 2, ?)
  `).run(JSON.stringify({ newRole: 'user', legacyEmail: 'secret@test.invalid' }));

  const authLog = await request('/api/admin/auth-events', {}, 1);
  assert.equal(authLog.response.status, 200);
  assert.equal(authLog.response.headers.get('cache-control'), 'private, no-store');
  const event = authLog.body.events.find((candidate: any) => candidate.event_type === 'admin_role_change');
  assert.ok(event);
  assert.deepEqual(Object.keys(event).sort(), [
    'admin_actor_id', 'admin_actor_username', 'created_at', 'event_type', 'id',
    'ip_address', 'reason', 'success', 'target_user_id', 'target_user_username',
    'user_agent', 'user_id', 'username',
  ]);
  assert.equal(event.email, undefined);
  assert.equal(event.meta, undefined);

  const activity = await request('/api/admin/users/2/activity', {}, 1);
  assert.equal(activity.response.status, 200);
  assert.equal(activity.response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(activity.body.providers, [{ provider: 'google' }]);
  assert.deepEqual(Object.keys(activity.body.events[0]).sort(), [
    'created_at', 'event_type', 'id', 'ip_address', 'reason', 'success',
  ]);

  const health = await request('/api/admin/system-health', {}, 1);
  assert.equal(health.response.status, 200);
  assert.equal(health.response.headers.get('cache-control'), 'private, no-store');
  assert.equal(health.body.googleCallbackUrl, undefined);
  assert.equal(health.body.steamReturnUrl, undefined);
  assert.equal(health.body.steamRealm, undefined);

  const analytics = await request('/api/admin/analytics/summary', {}, 1);
  assert.equal(analytics.response.status, 200);
  assert.equal(analytics.response.headers.get('cache-control'), 'private, no-store');

  const rssStatus = await request('/api/admin/rss/fetch-all/status', {}, 1);
  assert.equal(rssStatus.response.status, 200);
  assert.equal(rssStatus.response.headers.get('cache-control'), 'private, no-store');
});
