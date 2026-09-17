import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { youtubeChannelFeedUrl, youtubeChannelHomepageUrl } from '../../shared/youtube.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const JWT_SECRET = 'isolated-phase2-submission-jwt';
const CHANNEL = `UC${'s'.repeat(22)}`;
const VIDEO = 'submit_1234';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-phase2-submissions-'));
const databasePath = path.join(root, 'data', 'submissions.db');
const uploadsDir = path.join(root, 'uploads');
assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
Object.assign(process.env, {
  NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir,
  JWT_SECRET, SESSION_SECRET: 'isolated-phase2-session', RATE_LIMIT_ENABLED: 'true',
});

let db: Database.Database;
let server: ChildProcess | undefined;
let baseUrl = '';
let serverLog = '';
let submissions: typeof import('../../server/sourceSubmissions.js');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') return reject(new Error('No isolated port.'));
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function cookie(id: number): string {
  const user = db.prepare('SELECT id,username,role,is_verified FROM users WHERE id=?').get(id) as any;
  return `refugecloud_auth=${jwt.sign(user, JWT_SECRET, { expiresIn: '10m' })}`;
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
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env, PORT: String(port), APP_BASE_URL: baseUrl, WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', STEAM_API_KEY: '', STEAM_RETURN_URL: '', RESEND_API_KEY: '',
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
      (1,'adminphase2','Admin','admin@test.invalid','x','admin',1),
      (2,'memberphase2','Member','member@test.invalid','x','user',1),
      (3,'unverifiedphase2','Unverified','unverified@test.invalid','x','user',0),
      (4,'otherphase2','Other','other@test.invalid','x','user',1);
  `);
  submissions = await import('../../server/sourceSubmissions.js');
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server!.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  db?.close();
  if (!root.startsWith(path.join(os.tmpdir(), 'refugecloud-phase2-submissions-'))) throw new Error(`Unsafe cleanup: ${root}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('submission API enforces auth, verification, allowlisted fields, creates review records only, and rate limits', async () => {
  const endpoint = '/api/world-feed/source-submissions';
  const valid = { sourceKind: 'rss', locator: 'https://never-fetch.invalid/feed', name: 'Suggested', category: 'news', note: 'Please review' };
  assert.equal((await request(endpoint, { method: 'POST', body: JSON.stringify(valid) })).response.status, 401);
  assert.equal((await request(endpoint, { method: 'POST', body: JSON.stringify(valid) }, 3)).response.status, 403);
  assert.equal((await request(endpoint, { method: 'POST', body: JSON.stringify({ ...valid, sourceKind: 'playlist' }) }, 2)).response.status, 400);
  assert.equal((await request(endpoint, { method: 'POST', body: JSON.stringify({ ...valid, status: 'approved' }) }, 2)).response.status, 400);
  const created = await request(endpoint, { method: 'POST', body: JSON.stringify(valid) }, 2);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.submission.status, 'pending');
  assert.equal(created.body.submission.reviewedByUserId, undefined);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM external_source_submissions').get() as any).count, 1);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM external_sources').get() as any).count, 0);
  // Five attempts are allowed per hour from one client; the next attempt is bounded.
  assert.equal((await request(endpoint, { method: 'POST', body: JSON.stringify({ ...valid, locator: 'https://rate.invalid/feed' }) }, 4)).response.status, 429);
});

test('field limits and YouTube syntax normalize without network or source creation', () => {
  assert.throws(() => submissions.normalizeSubmissionInput({ sourceKind: 'rss', locator: 'https://example.test/' + 'x'.repeat(2049) }), /valid|2048|required/);
  assert.throws(() => submissions.normalizeSubmissionInput({ sourceKind: 'youtube_channel', locator: 'https://youtube.com/@unsupported' }), /channel ID/);
  const normalized = submissions.normalizeSubmissionInput({
    sourceKind: 'youtube_channel', locator: `https://www.youtube.com/channel/${CHANNEL}/`, name: ' Name ', category: '', note: ' Note ',
  });
  assert.deepEqual(normalized, { sourceKind: 'youtube_channel', locator: CHANNEL, name: 'Name', category: 'general', note: 'Note' });
  const beforeSources = (db.prepare('SELECT COUNT(*) count FROM external_sources').get() as any).count;
  submissions.createSourceSubmission(4, normalized);
  assert.equal((db.prepare('SELECT COUNT(*) count FROM external_sources').get() as any).count, beforeSources);
});

test('users see only their own safe submission state and duplicates do not disclose other-user activity', async () => {
  const mine = await request('/api/world-feed/source-submissions', {}, 2);
  assert.equal(mine.response.status, 200);
  assert.equal(mine.response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(mine.body.submissions.map((row: any) => row.name), ['Suggested']);
  assert.equal(mine.body.submissions[0].reviewNote, undefined);
  const other = await request('/api/world-feed/source-submissions', {}, 4);
  assert.deepEqual(other.body.submissions.map((row: any) => row.sourceKind), ['youtube_channel']);

  const first = submissions.createSourceSubmission(2, { sourceKind: 'youtube_channel', locator: CHANNEL });
  const repeated = submissions.createSourceSubmission(2, { sourceKind: 'youtube_channel', locator: CHANNEL });
  const anotherUser = submissions.createSourceSubmission(4, { sourceKind: 'youtube_channel', locator: CHANNEL });
  assert.equal(repeated.created, false);
  assert.equal(repeated.submission.id, first.submission.id);
  assert.notEqual(anotherUser.submission.id, first.submission.id);
});

function probe(name = 'Safe Channel', channelId = CHANNEL) {
  return {
    channelId,
    feedUrl: youtubeChannelFeedUrl(channelId),
    homepageUrl: youtubeChannelHomepageUrl(channelId),
    feed: {
      channelId, channelName: name,
      entries: [{ videoId: VIDEO, title: 'Video', description: '', channelName: name, publishedAt: '2026-09-17T00:00:00.000Z', providerUpdatedAt: null }],
    },
  };
}

test('non-admin review is rejected and failed provider validation leaves the submission pending', async () => {
  const pending = submissions.createSourceSubmission(4, { sourceKind: 'youtube_channel', locator: CHANNEL, name: 'Pending failure' }).submission;
  assert.equal((await request(`/api/admin/rss/source-submissions/${pending.id}/approve`, { method: 'POST', body: '{}' }, 2)).response.status, 403);
  await assert.rejects(submissions.approveSourceSubmission(pending.id, 1, {
    probeYoutube: async () => { throw new Error('provider unavailable'); },
  }), /provider unavailable/);
  assert.equal((db.prepare('SELECT status FROM external_source_submissions WHERE id=?').get(pending.id) as any).status, 'pending');
});

test('successful YouTube approval validates typed input, creates or reuses one source, links atomically, and audits by numeric ID', async () => {
  const pending = submissions.createSourceSubmission(2, { sourceKind: 'youtube_channel', locator: CHANNEL, name: 'Approved channel', category: 'video' }).submission;
  const approved = await submissions.approveSourceSubmission(pending.id, 1, { probeYoutube: async locator => {
    assert.equal(locator, CHANNEL);
    return probe();
  } });
  assert.equal(approved.status, 'approved');
  assert.equal((db.prepare("SELECT COUNT(*) count FROM external_sources WHERE provider='youtube' AND source_kind='youtube_channel' AND provider_source_id=?").get(CHANNEL) as any).count, 1);
  assert.equal((db.prepare("SELECT COUNT(*) count FROM external_items WHERE provider='youtube' AND provider_item_id=? AND item_kind='video'").get(VIDEO) as any).count, 1);
  assert.deepEqual(db.prepare(`SELECT event_type,actor_id,target_type,target_id FROM operational_audit WHERE event_type='external_source_submission.approve' ORDER BY id DESC LIMIT 1`).get(), {
    event_type: 'external_source_submission.approve', actor_id: 1, target_type: 'external_source_submission', target_id: String(pending.id),
  });

  const duplicate = submissions.createSourceSubmission(4, { sourceKind: 'youtube_channel', locator: CHANNEL }).submission;
  const resolved = await submissions.approveSourceSubmission(duplicate.id, 1, { probeYoutube: async () => probe() });
  assert.equal(resolved.resultingSourceId, approved.resultingSourceId);
  assert.equal((db.prepare("SELECT COUNT(*) count FROM external_sources WHERE provider_source_id=?").get(CHANNEL) as any).count, 1);
});

test('successful RSS approval validates and persists the feed only during admin review', async () => {
  const pending = submissions.createSourceSubmission(2, {
    sourceKind: 'rss', locator: 'https://rss-approval.invalid/feed', category: 'news',
  }).submission;
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Approved RSS</title>
    <link>https://rss-approval.invalid/</link><description>Fixture</description><item>
    <guid>approved-item</guid><title>Approved item</title><link>https://rss-approval.invalid/item</link>
    <pubDate>Wed, 16 Sep 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
  const fixture = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' });
    res.end(xml);
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as any).port;
  const transport = ((url: URL, options: any, callback: any) => http.request(
    new URL(url.pathname + url.search, `http://127.0.0.1:${port}`),
    { ...options, lookup: undefined, servername: undefined, headers: { ...options.headers, Host: url.host } },
    callback,
  )) as typeof https.request;
  try {
    const approved = await submissions.approveSourceSubmission(pending.id, 1, {
      rssNetwork: { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: transport },
    });
    assert.equal(approved.status, 'approved');
    const source = db.prepare('SELECT provider,source_kind,name,fetch_url,category FROM external_sources WHERE id=?')
      .get(approved.resultingSourceId) as any;
    assert.deepEqual(source, {
      provider: 'rss', source_kind: 'rss', name: 'Approved RSS',
      fetch_url: 'https://rss-approval.invalid/feed', category: 'news',
    });
    assert.equal((db.prepare("SELECT COUNT(*) count FROM external_items WHERE provider='rss'").get() as any).count, 1);
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
  }
});

test('source-creation failure rolls back approval and rejection records a durable safe reviewed state', async () => {
  const failingChannel = `UC${'f'.repeat(22)}`;
  const failing = submissions.createSourceSubmission(2, { sourceKind: 'youtube_channel', locator: failingChannel, name: 'Break transaction' }).submission;
  db.exec(`CREATE TRIGGER phase2_fail_source BEFORE INSERT ON external_sources WHEN NEW.name='Break transaction' BEGIN SELECT RAISE(ABORT,'injected'); END`);
  await assert.rejects(submissions.approveSourceSubmission(failing.id, 1, { probeYoutube: async () => probe('Safe Channel', failingChannel) }), /injected/);
  db.exec('DROP TRIGGER phase2_fail_source');
  assert.equal((db.prepare('SELECT status,resulting_source_id FROM external_source_submissions WHERE id=?').get(failing.id) as any).status, 'pending');

  const rejected = submissions.createSourceSubmission(2, { sourceKind: 'rss', locator: 'https://reject.invalid/feed' }).submission;
  const response = await request(`/api/admin/rss/source-submissions/${rejected.id}/reject`, { method: 'POST', body: JSON.stringify({ reason: 'Internal review note' }) }, 1);
  assert.equal(response.response.status, 200);
  assert.equal(response.body.submission.status, 'rejected');
  const own = await request('/api/world-feed/source-submissions', {}, 2);
  const safe = own.body.submissions.find((row: any) => row.id === rejected.id);
  assert.equal(safe.reviewNote, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /Internal review note/);
});

test('catalog DTO includes YouTube source kind but no ingestion endpoint or provider internals', async () => {
  const catalog = await request('/api/world-feed/sources', {}, 2);
  assert.equal(catalog.response.status, 200);
  const youtube = catalog.body.sources.find((source: any) => source.sourceKind === 'youtube_channel');
  assert.ok(youtube);
  assert.deepEqual(Object.keys(youtube).sort(), ['availability', 'category', 'homepageUrl', 'id', 'name', 'sourceKind', 'viewer']);
  assert.doesNotMatch(JSON.stringify(catalog.body), /feeds\/videos|fetch_url|provider_source_id|last_failure|review_note/);
});
