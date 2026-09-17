import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../../src/api/client.js';
import WorldPage from '../../src/pages/WorldPage.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const JWT_SECRET = 'isolated-external-content-phase1-jwt';
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
      if (!address || typeof address === 'string') return reject(new Error('No isolated test port.'));
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function cookie(userId: number): string {
  const row = db.prepare('SELECT id,username,role,is_verified FROM users WHERE id=?').get(userId) as any;
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-external-api-'));
  databasePath = path.join(root, 'data', 'api.db');
  uploadsDir = path.join(root, 'uploads');
  assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', PORT: String(port),
      DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir, JWT_SECRET,
      SESSION_SECRET: 'isolated-external-content-session', APP_BASE_URL: baseUrl, WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', STEAM_API_KEY: '', STEAM_RETURN_URL: '',
      RESEND_API_KEY: '', RATE_LIMIT_ENABLED: 'false',
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
  db.pragma('foreign_keys = ON');
  db.exec(`
    INSERT INTO users(id,username,display_name,email,password_hash,role,is_verified) VALUES
      (1,'adminext','Admin','adminext@test.invalid','test','admin',1),
      (2,'memberext','Member','memberext@test.invalid','test','user',1),
      (3,'pendingext','Pending','pendingext@test.invalid','test','user',0);
    INSERT INTO external_sources(id,provider,source_kind,name,fetch_url,homepage_url,category,is_active) VALUES
      (10,'rss','rss','Active Source','https://fetch-secret.example/rss','https://public.example/','news',1),
      (20,'rss','rss','Disabled Source','https://disabled-secret.example/rss','','news',0),
      (30,'rss','rss','Hidden Disabled Source','https://hidden-secret.example/rss','','news',0);
    UPDATE external_sources SET last_failure_code='RSS_FETCH_FAILED', last_failure_detail='private upstream detail' WHERE id=10;
    INSERT INTO external_items(id,provider,item_kind,title,canonical_url,published_at)
      VALUES (100,'rss','article','Active Item','https://public.example/item','2026-09-17T12:00:00Z');
    INSERT INTO external_source_items(source_id,item_id,source_entry_id) VALUES (10,100,'entry-100');
    INSERT INTO user_external_source_subscriptions(user_id,source_id) VALUES (2,20);
  `);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server!.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  db?.close();
  if (!root.startsWith(path.join(os.tmpdir(), 'refugecloud-external-api-'))) throw new Error(`Unsafe cleanup path: ${root}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('public catalog allowlists fields and personalized responses are private and truthful', async () => {
  const anonymous = await request('/api/world-feed/sources');
  assert.equal(anonymous.response.status, 200);
  assert.deepEqual(anonymous.body.sources.map((source: any) => source.id), [10]);
  assert.deepEqual(Object.keys(anonymous.body.sources[0]).sort(), ['availability', 'category', 'homepageUrl', 'id', 'name', 'sourceKind', 'viewer']);
  assert.equal(anonymous.body.sources[0].viewer, null);
  assert.doesNotMatch(JSON.stringify(anonymous.body), /fetch-secret|fetch_url|last_failure|upstream detail/);

  const personalized = await request('/api/world-feed/sources', {}, 2);
  assert.equal(personalized.response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(personalized.body.sources.map((source: any) => [source.id, source.availability, source.viewer.subscribed]), [
    [10, 'active', false], [20, 'disabled', true],
  ]);
});

test('subscription endpoints require verified auth, validate numeric IDs, remain idempotent, and preserve independent blocks', async () => {
  assert.equal((await request('/api/world-feed/sources/10/subscription', { method: 'PUT' })).response.status, 401);
  assert.equal((await request('/api/world-feed/sources/10/subscription', { method: 'PUT' }, 3)).response.status, 403);
  assert.equal((await request('/api/world-feed/sources/not-a-number/subscription', { method: 'PUT' }, 2)).response.status, 400);
  assert.equal((await request('/api/world-feed/sources/20/subscription', { method: 'PUT' }, 2)).response.status, 404);
  const hiddenDisabled = await request('/api/world-feed/sources/30/block', { method: 'POST' }, 2);
  const missingSource = await request('/api/world-feed/sources/999999/block', { method: 'POST' }, 2);
  assert.equal(hiddenDisabled.response.status, 404);
  assert.deepEqual(hiddenDisabled.body, missingSource.body);

  const first = await request('/api/world-feed/sources/10/subscription', { method: 'PUT' }, 2);
  const repeated = await request('/api/world-feed/sources/10/subscription', { method: 'PUT' }, 2);
  assert.deepEqual(first.body, { sourceId: 10, subscribed: true, blocked: false });
  assert.deepEqual(repeated.body, first.body);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions WHERE user_id=2 AND source_id=10').get() as any).count, 1);

  assert.equal((await request('/api/world-feed/sources/10/block', { method: 'POST' }, 2)).response.status, 200);
  assert.equal((await request('/api/world-feed/sources/10/subscription', { method: 'PUT' }, 2)).response.status, 409);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions WHERE user_id=2 AND source_id=10').get() as any).count, 1);
  const removed = await request('/api/world-feed/sources/10/subscription', { method: 'DELETE' }, 2);
  const repeatedDelete = await request('/api/world-feed/sources/10/subscription', { method: 'DELETE' }, 2);
  assert.deepEqual(removed.body, { sourceId: 10, subscribed: false, blocked: true });
  assert.deepEqual(repeatedDelete.body, removed.body);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_blocks WHERE user_id=2 AND source_id=10').get() as any).count, 1);
});

test('World discovery and authenticated personal feed never silently share eligibility', async () => {
  const discovery = await request('/api/world-feed');
  assert.deepEqual(discovery.body.items.map((item: any) => item.id), [100]);
  const anonymousPersonal = await request('/api/feed?level=world');
  assert.deepEqual(anonymousPersonal.body.items, []);
  assert.equal(anonymousPersonal.body.personalExternalFeedStatus, 'authentication_required');

  await request('/api/world-feed/sources/10/block', { method: 'DELETE' }, 2);
  await request('/api/world-feed/sources/20/subscription', { method: 'DELETE' }, 2);
  const noSubscription = await request('/api/feed?level=world', {}, 2);
  assert.deepEqual(noSubscription.body.items, []);
  assert.equal(noSubscription.body.personalExternalFeedStatus, 'no_subscriptions');
  await request('/api/world-feed/sources/10/subscription', { method: 'PUT' }, 2);
  const personal = await request('/api/feed?level=world', {}, 2);
  assert.deepEqual(personal.body.items.map((item: any) => item.id), [100]);
  assert.equal(personal.body.personalExternalFeedStatus, 'ready');
});

test('admin RSS creation writes generalized storage only and does not auto-subscribe users', async () => {
  const beforeLegacy = (db.prepare('SELECT COUNT(*) AS count FROM rss_sources').get() as any).count;
  const created = await request('/api/admin/rss/sources', {
    method: 'POST', body: JSON.stringify({ name: 'Created Later', url: 'https://created.example/rss', homepageUrl: '', category: 'news' }),
  }, 1);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.source.sourceKind, 'rss');
  assert.equal(created.body.source.fetch_url, undefined);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM external_sources WHERE name='Created Later'").get() as any).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM rss_sources').get() as any).count, beforeLegacy);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM user_external_source_subscriptions WHERE source_id=?').get(created.body.source.id) as any).count, 0);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function textOf(rootNode: ReactTestInstance): string {
  return rootNode.findAll(() => true).flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
}

test('World subscription UI serializes writes, reconciles confirmation, and ignores an obsolete account response', async () => {
  const originals = { get: api.get, put: api.put, delete: api.delete };
  const pending = deferred<any>();
  let writes = 0;
  let account = 1;
  api.get = async (url: string) => {
    if (url.includes('blocked-sources')) return { blocked: [] };
    if (url.includes('/sources')) return { sources: [{
      id: account, name: `Source ${account}`, category: 'news', homepageUrl: '', sourceKind: 'rss',
      availability: 'active', viewer: { subscribed: false, blocked: false },
    }], categories: ['news'] };
    return { items: [], pagination: { hasMore: false } };
  };
  api.put = async () => { writes += 1; return pending.promise; };
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(React.createElement(MemoryRouter, {}, React.createElement(WorldPage, { user: { id: 1, is_verified: 1 } }))); });
    const subscribe = view.root.findAllByType('button').find(node => node.children.join('') === 'Subscribe')!;
    await act(async () => { void subscribe.props.onClick(); void subscribe.props.onClick(); });
    assert.equal(writes, 1);
    assert.match(textOf(view.root), /Saving/);

    account = 2;
    await act(async () => view.update(React.createElement(MemoryRouter, {}, React.createElement(WorldPage, { user: { id: 2, is_verified: 1 } }))));
    assert.match(textOf(view.root), /Source 2/);
    await act(async () => pending.resolve({ sourceId: 1, subscribed: true, blocked: false }));
    assert.match(textOf(view.root), /Source 2/);
    assert.doesNotMatch(textOf(view.root), /Unsubscribe/);
  } finally {
    Object.assign(api, originals);
    if (view) await act(async () => view.unmount());
  }
});

test('Phase 1 World UI has article/podcast controls but introduces no video-source UI', () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'src/pages/WorldPage.tsx'), 'utf8');
  assert.match(source, /Podcasts/);
  assert.doesNotMatch(source, /youtube_channel|youtube_playlist|YouTube channel|video source/i);
});
