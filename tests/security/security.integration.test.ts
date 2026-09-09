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
import bcrypt from 'bcryptjs';
import { resolveProviderAccount, type ProviderIdentity } from '../../server/providerAccounts.js';

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
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('origin') && !headers.has('x-test-no-origin')) {
    headers.set('origin', baseUrl);
  }
  if (headers.has('x-test-no-origin')) {
    headers.delete('x-test-no-origin');
    headers.set('host', 'refugecloud.com');
  }
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
  const values = (response.headers as any).getSetCookie?.() as string[] | undefined;
  const raw = values?.find(value => value.startsWith('connect.sid=')) || response.headers.get('set-cookie');
  assert.ok(raw, 'expected a session cookie');
  const match = raw.match(/connect\.sid=[^;,]+/);
  assert.ok(match, 'expected a Passport session cookie');
  return match[0];
}

function namedSetCookie(response: Response, name: string): string {
  const values = (response.headers as any).getSetCookie?.() as string[] | undefined;
  const raw = values?.find(value => value.startsWith(`${name}=`)) || response.headers.get('set-cookie') || '';
  const match = raw.match(new RegExp(`${name}=[^;,]*`));
  assert.ok(match, `expected ${name} cookie`);
  return match[0];
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function googleIdentity(overrides: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    provider: 'google',
    providerUserId: 'google-test-user',
    email: 'provider-user@test.invalid',
    emailVerified: true,
    displayName: 'Provider User',
    avatarUrl: 'https://provider.invalid/avatar.png',
    ...overrides,
  };
}

function user(username: string): { id: number; username: string; auth_version: number } {
  return db.prepare('SELECT id, username, auth_version FROM users WHERE username = ?')
    .get(username) as { id: number; username: string; auth_version: number };
}

async function login(username: string, password = 'Password123!'): Promise<string> {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return namedSetCookie(result.response, 'refugecloud_auth');
}

async function passportSession(userId: number): Promise<{ cookie: string; sid: string }> {
  const initiation = await request('/api/auth/google');
  assert.equal(initiation.response.status, 302);
  const state = new URL(initiation.response.headers.get('location')!).searchParams.get('state');
  const row = db.prepare('SELECT sid, sess FROM sessions WHERE json_extract(sess, ?) = ?')
    .get('$.googleOAuthState.value', state) as { sid: string; sess: string };
  assert.ok(row);
  const stored = JSON.parse(row.sess);
  stored.passport = { user: { id: userId } };
  db.prepare('UPDATE sessions SET sess = ?, expire = ? WHERE sid = ?')
    .run(JSON.stringify(stored), Date.now() + 60_000, row.sid);
  return { cookie: firstSetCookie(initiation.response), sid: row.sid };
}

function combineCookies(...cookies: string[]): string {
  return cookies.join('; ');
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
      CSRF_ENFORCE_IN_TESTS: 'true',
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
     VALUES (?, ?, ?, ?, ?, ?, 'everyone')`,
  );
  const passwordHash = bcrypt.hashSync('Password123!', 4);
  insertUser.run('owner', 'Owner', 'owner@test.invalid', passwordHash, 1, 'public');
  insertUser.run('reporter', 'Reporter', 'reporter@test.invalid', passwordHash, 1, 'public');
  insertUser.run('unverified', 'Unverified', 'unverified@test.invalid', passwordHash, 0, 'public');
  insertUser.run('privateuser', 'Private User', 'private@test.invalid', passwordHash, 1, 'private');
  insertUser.run('credential', 'Credential User', 'credential@test.invalid', passwordHash, 1, 'public');
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

test('session store writes epoch expiry, touches safely, and fails closed on malformed legacy rows', async () => {
  const initiation = await request('/api/auth/google');
  const cookie = firstSetCookie(initiation.response);
  const state = new URL(initiation.response.headers.get('location')!).searchParams.get('state');
  const row = db.prepare(`
    SELECT sid, expire_ms, typeof(expire_ms) AS storage_type
    FROM sessions WHERE json_extract(sess, ?) = ?
  `).get('$.googleOAuthState.value', state) as { sid: string; expire_ms: number; storage_type: string };
  assert.equal(row.storage_type, 'integer');
  assert.ok(Number(row.expire_ms) > Date.now());

  await request('/api/auth/providers', { headers: { cookie } });
  const touched = db.prepare('SELECT expire_ms, typeof(expire_ms) AS storage_type FROM sessions WHERE sid = ?')
    .get(row.sid) as { expire_ms: number; storage_type: string };
  assert.equal(touched.storage_type, 'integer');
  assert.ok(Number(touched.expire_ms) >= Number(row.expire_ms));

  db.prepare('UPDATE sessions SET expire = ?, expire_ms = NULL WHERE sid = ?')
    .run('2999-01-01T00:00:00.000Z', row.sid);
  await request('/api/auth/providers', { headers: { cookie } });
  const converted = db.prepare('SELECT expire_ms, typeof(expire_ms) AS storage_type FROM sessions WHERE sid = ?')
    .get(row.sid) as { expire_ms: number; storage_type: string };
  assert.equal(converted.storage_type, 'integer');

  db.prepare('UPDATE sessions SET expire = ?, expire_ms = NULL WHERE sid = ?').run('malformed-expiry', row.sid);
  await request('/api/auth/providers', { headers: { cookie } });
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE sid = ?').get(row.sid), undefined);
});

test('Steam callback requires a session-bound login intent', async () => {
  const result = await request('/api/auth/steam/callback');
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get('location'), `${baseUrl}/login?error=steam_failed`);
});

test('JWT application identity overrides or clears every Passport identity combination', async () => {
  const privateAccount = user('privateuser');
  const reporter = user('reporter');
  const passport = await passportSession(privateAccount.id);
  const privateJwt = authCookie(privateAccount);
  const reporterJwt = authCookie(reporter);
  const profileAccess = async (cookieHeader?: string) => {
    const result = await request('/api/users/privateuser', {
      headers: cookieHeader ? { cookie: cookieHeader } : undefined,
    });
    return {
      status: result.response.status,
      limited: result.body.user?.limited === true,
    };
  };

  assert.deepEqual(await profileAccess(privateJwt), { status: 200, limited: false }, 'valid JWT only');
  assert.deepEqual(await profileAccess(passport.cookie), { status: 404, limited: false }, 'Passport only');
  assert.deepEqual(await profileAccess(combineCookies(privateJwt, passport.cookie)), { status: 200, limited: false }, 'matching identities');
  assert.deepEqual(await profileAccess(combineCookies(reporterJwt, passport.cookie)), { status: 200, limited: true }, 'conflicting identities');

  const expired = jwt.sign(
    { id: privateAccount.id, username: privateAccount.username, role: 'user', is_verified: 1 },
    JWT_SECRET,
    { expiresIn: -1 },
  );
  assert.deepEqual(await profileAccess(combineCookies(`refugecloud_auth=${expired}`, passport.cookie)), { status: 404, limited: false }, 'expired JWT');
  assert.deepEqual(await profileAccess(combineCookies('refugecloud_auth=malformed', passport.cookie)), { status: 404, limited: false }, 'malformed JWT');

  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(privateAccount.id);
  assert.equal((await request('/api/auth/me', {
    headers: { cookie: combineCookies(privateJwt, passport.cookie) },
  })).response.status, 403);
  assert.deepEqual(await profileAccess(combineCookies(privateJwt, passport.cookie)), { status: 404, limited: false }, 'banned account');
  db.prepare('UPDATE users SET banned = 0 WHERE id = ?').run(privateAccount.id);

  const activeCookie = await login('privateuser');
  const activeToken = activeCookie.slice(activeCookie.indexOf('=') + 1);
  const activePayload = jwt.decode(activeToken) as { jti: string };
  db.prepare('UPDATE application_auth_sessions SET revoked_at_ms = ? WHERE session_id = ?')
    .run(Date.now(), activePayload.jti);
  assert.deepEqual(await profileAccess(combineCookies(activeCookie, passport.cookie)), { status: 404, limited: false }, 'revoked JWT');

  const meWithPassport = await request('/api/auth/me', { headers: { cookie: passport.cookie } });
  assert.equal(meWithPassport.response.status, 401);
  const deniedMutation = await request('/api/posts', {
    method: 'POST', headers: { cookie: passport.cookie }, body: JSON.stringify({ content: 'DENIED' }),
  });
  assert.equal(deniedMutation.response.status, 401);

  const allowedMutation = await request('/api/posts', {
    method: 'POST', headers: { cookie: reporterJwt }, body: JSON.stringify({ content: 'JWT AUTHORIZED' }),
  });
  assert.equal(allowedMutation.response.status, 201);
  db.prepare('DELETE FROM posts WHERE id = ?').run(allowedMutation.body.post.id);
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(passport.sid);
});

test('logout revokes the application JWT, destroys Passport state, and is idempotent', async () => {
  const privateAccount = user('privateuser');
  const appCookie = await login('privateuser');
  const passport = await passportSession(privateAccount.id);
  const retainedCookies = combineCookies(appCookie, passport.cookie);

  const before = await request('/api/users/privateuser', { headers: { cookie: retainedCookies } });
  assert.equal(before.body.user.limited, undefined);

  const logout = await request('/api/auth/logout', {
    method: 'POST', headers: { cookie: retainedCookies },
  });
  assert.equal(logout.response.status, 200);
  assert.equal(namedSetCookie(logout.response, 'refugecloud_auth'), 'refugecloud_auth=');
  assert.equal(namedSetCookie(logout.response, 'connect.sid'), 'connect.sid=');
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE sid = ?').get(passport.sid), undefined);

  const replayedRead = await request('/api/users/privateuser', { headers: { cookie: retainedCookies } });
  assert.equal(replayedRead.response.status, 404);
  assert.equal((await request('/api/auth/me', { headers: { cookie: retainedCookies } })).response.status, 401);
  assert.equal((await request('/api/posts', {
    method: 'POST', headers: { cookie: retainedCookies }, body: JSON.stringify({ content: 'DENIED AFTER LOGOUT' }),
  })).response.status, 401);

  const repeated = await request('/api/auth/logout', {
    method: 'POST', headers: { cookie: retainedCookies },
  });
  assert.equal(repeated.response.status, 200);

  const switchedCookie = await request('/api/auth/login', {
    method: 'POST',
    headers: { cookie: retainedCookies },
    body: JSON.stringify({ username: 'owner', password: 'Password123!' }),
  });
  assert.equal(switchedCookie.response.status, 200);
  const ownerCookie = namedSetCookie(switchedCookie.response, 'refugecloud_auth');
  const switchedMe = await request('/api/auth/me', { headers: { cookie: ownerCookie } });
  assert.equal(switchedMe.body.user.username, 'owner');
  await request('/api/auth/logout', { method: 'POST', headers: { cookie: ownerCookie } });
});

test('password reset and password change revoke same-second and recorded sessions', async () => {
  const account = user('credential');
  const passport = await passportSession(account.id);
  db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)')
    .run(account.id, user('privateuser').id);
  const legacySameSecond = jwt.sign({
    id: account.id,
    username: account.username,
    role: 'user',
    is_verified: 1,
    iat: Math.floor(Date.now() / 1000),
  }, JWT_SECRET, { expiresIn: '10m' });
  const firstCookie = await login('credential');
  assert.equal((await request('/api/auth/me', {
    headers: { cookie: `refugecloud_auth=${legacySameSecond}` },
  })).response.status, 200);
  const resetToken = 'batch-02-reset-token';
  db.prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(account.id, hashToken(resetToken), '2999-01-01T00:00:00.000Z');

  const reset = await request('/api/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token: resetToken, newPassword: 'Password456!' }),
  });
  assert.equal(reset.response.status, 200);
  assert.equal((await request('/api/auth/me', { headers: { cookie: firstCookie } })).response.status, 401);
  assert.equal((await request('/api/auth/me', {
    headers: { cookie: `refugecloud_auth=${legacySameSecond}` },
  })).response.status, 401);
  const staleCombination = await request('/api/users/privateuser', {
    headers: { cookie: combineCookies(firstCookie, passport.cookie) },
  });
  assert.equal(staleCombination.response.status, 404);

  const afterReset = await login('credential', 'Password456!');
  const changed = await request('/api/auth/change-password', {
    method: 'POST',
    headers: { cookie: afterReset },
    body: JSON.stringify({ currentPassword: 'Password456!', newPassword: 'Password789!' }),
  });
  assert.equal(changed.response.status, 200);
  assert.equal((await request('/api/auth/me', { headers: { cookie: afterReset } })).response.status, 401);
  const afterChange = await login('credential', 'Password789!');
  assert.equal((await request('/api/auth/me', { headers: { cookie: afterChange } })).response.status, 200);
  await request('/api/auth/logout', { method: 'POST', headers: { cookie: afterChange } });

  db.prepare('UPDATE users SET password_hash = ?, auth_version = 0, password_changed_at = NULL WHERE id = ?')
    .run(bcrypt.hashSync('Password123!', 4), account.id);
  db.prepare('DELETE FROM application_auth_sessions WHERE user_id = ?').run(account.id);
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(passport.sid);
  db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?')
    .run(account.id, user('privateuser').id);
});

test('OAuth handoff is one-time, revocation-aware, and removes Passport authentication', async () => {
  const owner = user('owner');
  const passport = await passportSession(owner.id);
  const session = db.prepare('SELECT sess FROM sessions WHERE sid = ?').get(passport.sid) as { sess: string };
  const stored = JSON.parse(session.sess);
  const sessionId = 'oauth-handoff-session-id-000000000000';
  const token = jwt.sign({
    id: owner.id,
    username: owner.username,
    role: 'user',
    is_verified: 1,
    auth_version: owner.auth_version,
  }, JWT_SECRET, { expiresIn: '10m', jwtid: sessionId });
  stored.oauthHandoffToken = token;
  stored.oauthHandoffUsername = owner.username;
  db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?').run(JSON.stringify(stored), passport.sid);
  db.prepare(`
    INSERT INTO application_auth_sessions (session_id, user_id, expires_at_ms, created_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, owner.id, Date.now() + 60_000, Date.now());

  const claimed = await request('/api/auth/oauth-token', { headers: { cookie: passport.cookie } });
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.body.user.username, owner.username);
  const appCookie = namedSetCookie(claimed.response, 'refugecloud_auth');
  assert.equal(namedSetCookie(claimed.response, 'connect.sid'), 'connect.sid=');
  assert.equal(db.prepare('SELECT 1 FROM sessions WHERE sid = ?').get(passport.sid), undefined);
  assert.equal((await request('/api/auth/oauth-token', { headers: { cookie: passport.cookie } })).response.status, 401);
  assert.equal((await request('/api/auth/me', { headers: { cookie: appCookie } })).response.status, 200);
  const logout = await request('/api/auth/logout', { method: 'POST', headers: { cookie: appCookie } });
  assert.equal(logout.response.status, 200);
  assert.equal((await request('/api/auth/me', { headers: { cookie: appCookie } })).response.status, 401);
});

test('application-session expiry is authoritative before JWT expiry', async () => {
  const appCookie = await login('reporter');
  const payload = jwt.decode(appCookie.slice(appCookie.indexOf('=') + 1)) as { jti: string };
  assert.equal((await request('/api/auth/me', { headers: { cookie: appCookie } })).response.status, 200);
  db.prepare('UPDATE application_auth_sessions SET expires_at_ms = ? WHERE session_id = ?')
    .run(Date.now() - 1, payload.jti);
  assert.equal((await request('/api/auth/me', { headers: { cookie: appCookie } })).response.status, 401);
});

test('email verification cannot silently switch a different active application account', async () => {
  const ownerCookie = await login('owner');
  const target = user('unverified');
  const verificationToken = 'batch-02-account-switch-verification';
  db.prepare(`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(target.id, hashToken(verificationToken), '2999-01-01T00:00:00.000Z');

  const verified = await request(`/api/auth/verify-email?token=${verificationToken}`, {
    headers: { cookie: ownerCookie },
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.user, undefined);
  const stillOwner = await request('/api/auth/me', { headers: { cookie: ownerCookie } });
  assert.equal(stillOwner.body.user.username, 'owner');

  db.prepare('UPDATE users SET is_verified = 0, verified_at = NULL WHERE id = ?').run(target.id);
  await request('/api/auth/logout', { method: 'POST', headers: { cookie: ownerCookie } });
});

test('production-like mutation origin enforcement remains deliberately scoped', async () => {
  const validOrigin = await request('/api/posts', {
    method: 'POST', body: JSON.stringify({ content: 'NO AUTH' }),
  });
  assert.equal(validOrigin.response.status, 401);

  const missingOrigin = await request('/api/posts', {
    method: 'POST',
    headers: { 'x-test-no-origin': '1' },
    body: JSON.stringify({ content: 'NO ORIGIN' }),
  });
  assert.equal(missingOrigin.response.status, 403);
  assert.deepEqual(missingOrigin.body, { error: 'Invalid request origin.' });

  const invalidOrigin = await request('/api/posts', {
    method: 'POST',
    headers: { origin: 'https://attacker.invalid' },
    body: JSON.stringify({ content: 'BAD ORIGIN' }),
  });
  assert.equal(invalidOrigin.response.status, 403);

  const oauthGet = await request('/api/auth/google');
  assert.equal(oauthGet.response.status, 302);
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

test('verified provider email cannot auto-link an established verified account', () => {
  const owner = user('owner');
  const result = resolveProviderAccount(db, googleIdentity({
    providerUserId: 'google-verified-collision',
    email: 'OWNER@TEST.INVALID',
  }));

  assert.deepEqual(result, {
    ok: false,
    reason: 'verified_account_requires_explicit_link',
  });
  assert.equal(
    db.prepare('SELECT 1 FROM user_auth_providers WHERE provider_user_id = ?')
      .get('google-verified-collision'),
    undefined,
  );
  assert.equal(user('owner').id, owner.id);
});

test('verified Google identity reclaims only a provider-free unverified local account', async () => {
  const passwordHash = bcrypt.hashSync('AttackerPassword123!', 4);
  const inserted = db.prepare(`
    INSERT INTO users
      (username, display_name, email, password_hash, is_verified, profile_visibility, feed_exposure)
    VALUES ('reclaim_target', 'Reclaim Target', 'reclaim@test.invalid', ?, 0, 'public', 'everyone')
  `).run(passwordHash);
  const userId = Number(inserted.lastInsertRowid);
  const oldCookie = await login('reclaim_target', 'AttackerPassword123!');
  const sessionBefore = db.prepare(
    'SELECT session_id FROM application_auth_sessions WHERE user_id = ? AND revoked_at_ms IS NULL',
  ).get(userId) as { session_id: string };
  assert.ok(sessionBefore);

  const postId = Number(db.prepare(
    "INSERT INTO posts (user_id, content) VALUES (?, 'content survives reclamation')",
  ).run(userId).lastInsertRowid);
  db.prepare(`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, '2999-01-01T00:00:00.000Z')
  `).run(userId, hashToken('reclaim-verification-token'));
  db.prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, '2999-01-01T00:00:00.000Z')
  `).run(userId, hashToken('reclaim-reset-token'));

  const nowMs = Date.UTC(2026, 8, 9, 12, 0, 0, 321);
  const result = resolveProviderAccount(db, googleIdentity({
    providerUserId: 'google-legitimate-owner',
    email: ' Reclaim@Test.Invalid ',
  }), nowMs);
  if (!result.ok) assert.fail(result.reason);
  assert.equal(result.kind, 'reclaimed');
  assert.equal(result.userId, userId);

  const reclaimed = db.prepare(`
    SELECT password_hash, password_changed_at, is_verified, auth_version
    FROM users WHERE id = ?
  `).get(userId) as {
    password_hash: string;
    password_changed_at: string;
    is_verified: number;
    auth_version: number;
  };
  assert.equal(reclaimed.password_hash, '');
  assert.equal(reclaimed.password_changed_at, '2026-09-09T12:00:00.321Z');
  assert.equal(reclaimed.is_verified, 1);
  assert.equal(reclaimed.auth_version, 1);
  assert.equal(
    (db.prepare('SELECT revoked_at_ms FROM application_auth_sessions WHERE session_id = ?')
      .get(sessionBefore.session_id) as { revoked_at_ms: number }).revoked_at_ms,
    nowMs,
  );
  assert.ok(
    (db.prepare('SELECT used_at FROM email_verification_tokens WHERE user_id = ?')
      .get(userId) as { used_at: string }).used_at,
  );
  assert.ok(
    (db.prepare('SELECT used_at FROM password_reset_tokens WHERE user_id = ?')
      .get(userId) as { used_at: string }).used_at,
  );
  assert.ok(db.prepare('SELECT 1 FROM posts WHERE id = ? AND user_id = ?').get(postId, userId));
  assert.ok(db.prepare(`
    SELECT 1 FROM user_auth_providers
    WHERE user_id = ? AND provider = 'google' AND provider_user_id = ?
  `).get(userId, 'google-legitimate-owner'));

  assert.equal((await request('/api/auth/me', { headers: { cookie: oldCookie } })).response.status, 401);
  assert.equal((await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'reclaim_target', password: 'AttackerPassword123!' }),
  })).response.status, 401);
  assert.equal((await request('/api/auth/verify-email?token=reclaim-verification-token')).response.status, 400);
  assert.equal((await request('/api/auth/reset-password?token=reclaim-reset-token')).response.status, 400);

  const providerSessionId = 'provider-reclamation-session-00000001';
  const providerToken = jwt.sign({
    id: userId,
    username: 'reclaim_target',
    role: 'user',
    is_verified: 1,
    auth_version: reclaimed.auth_version,
  }, JWT_SECRET, { expiresIn: '10m', jwtid: providerSessionId });
  db.prepare(`
    INSERT INTO application_auth_sessions (session_id, user_id, expires_at_ms, created_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(providerSessionId, userId, Date.now() + 60_000, Date.now());
  assert.equal((await request('/api/auth/me', {
    headers: { cookie: `refugecloud_auth=${providerToken}` },
  })).response.status, 200);

  const replay = resolveProviderAccount(db, googleIdentity({
    providerUserId: 'google-legitimate-owner',
    email: 'new-provider-email@test.invalid',
    displayName: 'Updated Provider Name',
  }));
  if (!replay.ok) assert.fail(replay.reason);
  assert.equal(replay.kind, 'existing');
  assert.equal(replay.userId, userId);
  assert.equal(
    (db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string }).email,
    'reclaim@test.invalid',
  );

  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

test('provider IDs stay authoritative and provider/account collisions are refused', () => {
  const created = resolveProviderAccount(db, googleIdentity({
    providerUserId: 'google-authoritative-id',
    email: 'first-provider@test.invalid',
    displayName: 'CaseName',
  }));
  if (!created.ok) assert.fail(created.reason);
  assert.equal(created.kind, 'created');

  const changedEmail = resolveProviderAccount(db, googleIdentity({
    providerUserId: 'google-authoritative-id',
    email: 'changed-provider@test.invalid',
    displayName: 'Changed Name',
  }));
  if (!changedEmail.ok) assert.fail(changedEmail.reason);
  assert.equal(changedEmail.userId, created.userId);
  assert.equal(
    (db.prepare('SELECT email FROM users WHERE id = ?').get(created.userId) as { email: string }).email,
    'first-provider@test.invalid',
  );

  const differentProviderId = resolveProviderAccount(db, googleIdentity({
    providerUserId: 'google-second-id-same-email',
    email: 'FIRST-PROVIDER@TEST.INVALID',
  }));
  assert.deepEqual(differentProviderId, {
    ok: false,
    reason: 'verified_account_requires_explicit_link',
  });

  db.prepare(`
    INSERT INTO user_auth_providers
      (user_id, provider, provider_user_id, provider_email)
    VALUES (?, 'steam', 'steam-combination-id', '')
  `).run(created.userId);
  const steam = resolveProviderAccount(db, {
    provider: 'steam',
    providerUserId: 'steam-combination-id',
    email: '',
    emailVerified: false,
    displayName: 'Steam Name',
    avatarUrl: '',
  });
  if (!steam.ok) assert.fail(steam.reason);
  assert.equal(steam.userId, created.userId);

  assert.throws(() => db.prepare(`
    INSERT INTO user_auth_providers
      (user_id, provider, provider_user_id, provider_email)
    VALUES (?, 'google', 'google-third-id', '')
  `).run(created.userId), /UNIQUE constraint failed/);

  db.prepare('UPDATE users SET banned = 1 WHERE id = ?').run(created.userId);
  assert.deepEqual(
    resolveProviderAccount(db, googleIdentity({ providerUserId: 'google-authoritative-id' })),
    { ok: false, reason: 'account_banned' },
  );
  assert.deepEqual(
    resolveProviderAccount(db, googleIdentity({
      providerUserId: 'google-banned-email-id',
      email: 'first-provider@test.invalid',
    })),
    { ok: false, reason: 'account_banned' },
  );
  db.prepare('DELETE FROM users WHERE id = ?').run(created.userId);
});

test('unverified accounts with an established provider cannot be reclaimed by email', () => {
  const result = db.prepare(`
    INSERT INTO users
      (username, display_name, email, password_hash, is_verified, profile_visibility)
    VALUES ('provider_conflict', 'Provider Conflict', 'provider-conflict@test.invalid', ?, 0, 'public')
  `).run(bcrypt.hashSync('Password123!', 4));
  const userId = Number(result.lastInsertRowid);
  db.prepare(`
    INSERT INTO user_auth_providers
      (user_id, provider, provider_user_id, provider_email)
    VALUES (?, 'steam', 'existing-steam-owner', '')
  `).run(userId);

  assert.deepEqual(resolveProviderAccount(db, googleIdentity({
    providerUserId: 'google-provider-conflict',
    email: 'provider-conflict@test.invalid',
  })), {
    ok: false,
    reason: 'unverified_account_has_existing_provider',
  });
  const unchanged = db.prepare(
    'SELECT password_hash, is_verified, auth_version FROM users WHERE id = ?',
  ).get(userId) as { password_hash: string; is_verified: number; auth_version: number };
  assert.ok(unchanged.password_hash);
  assert.equal(unchanged.is_verified, 0);
  assert.equal(unchanged.auth_version, 0);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

test('registration duplicate handling is generic and case-insensitive', async () => {
  const created = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username: 'CaseSensitiveName',
      displayName: 'Case Sensitive',
      email: 'Case.Email@Test.Invalid',
      password: 'Password123!',
    }),
  });
  assert.equal(created.response.status, 201);
  const account = db.prepare(`
    SELECT id, username, email FROM users WHERE username = 'CaseSensitiveName'
  `).get() as { id: number; username: string; email: string };
  assert.equal(account.username, 'CaseSensitiveName');
  assert.equal(account.email, 'case.email@test.invalid');

  const attempts = [
    { username: 'CaseSensitiveName', email: 'unused-one@test.invalid' },
    { username: 'UnusedNameOne', email: 'case.email@test.invalid' },
    { username: 'CaseSensitiveName', email: 'case.email@test.invalid' },
    { username: 'casesensitivename', email: 'unused-two@test.invalid' },
    { username: 'UnusedNameTwo', email: 'CASE.EMAIL@TEST.INVALID' },
  ];
  for (const attempt of attempts) {
    const duplicate = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        ...attempt,
        displayName: 'Duplicate Attempt',
        password: 'Password123!',
      }),
    });
    assert.equal(duplicate.response.status, 400);
    assert.deepEqual(duplicate.body, { error: 'Username or email already taken.' });
  }

  const caseVariantLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'casesensitivename', password: 'Password123!' }),
  });
  assert.equal(caseVariantLogin.response.status, 200);
  db.prepare('DELETE FROM users WHERE id = ?').run(account.id);
});

test('verification preserves active identity and supports same-account or logged-out flows', async () => {
  const passwordHash = bcrypt.hashSync('Password123!', 4);
  const insert = db.prepare(`
    INSERT INTO users
      (username, display_name, email, password_hash, is_verified, profile_visibility)
    VALUES (?, ?, ?, ?, 0, 'public')
  `);
  const sameId = Number(insert.run(
    'verify_same', 'Verify Same', 'verify-same@test.invalid', passwordHash,
  ).lastInsertRowid);
  const loggedOutId = Number(insert.run(
    'verify_logged_out', 'Verify Logged Out', 'verify-out@test.invalid', passwordHash,
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, '2999-01-01T00:00:00.000Z')
  `).run(sameId, hashToken('verify-same-token'));
  db.prepare(`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, '2999-01-01T00:00:00.000Z')
  `).run(loggedOutId, hashToken('verify-logged-out-token'));

  const sameCookie = await login('verify_same');
  const sameResult = await request('/api/auth/verify-email?token=verify-same-token', {
    headers: { cookie: sameCookie },
  });
  assert.equal(sameResult.response.status, 200);
  assert.equal(sameResult.body.user.username, 'verify_same');
  const refreshedSameCookie = namedSetCookie(sameResult.response, 'refugecloud_auth');
  assert.equal((await request('/api/auth/me', {
    headers: { cookie: refreshedSameCookie },
  })).body.user.username, 'verify_same');

  const loggedOutResult = await request('/api/auth/verify-email?token=verify-logged-out-token');
  assert.equal(loggedOutResult.response.status, 200);
  assert.equal(loggedOutResult.body.user.username, 'verify_logged_out');
  const loggedOutCookie = namedSetCookie(loggedOutResult.response, 'refugecloud_auth');
  assert.equal((await request('/api/auth/me', {
    headers: { cookie: loggedOutCookie },
  })).body.user.username, 'verify_logged_out');

  db.prepare('DELETE FROM users WHERE id IN (?, ?)').run(sameId, loggedOutId);
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
