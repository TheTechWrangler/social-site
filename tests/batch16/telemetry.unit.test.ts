import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import Database from 'better-sqlite3';
import { canonicalTelemetryRoute, UNKNOWN_TELEMETRY_ROUTE } from '../../shared/telemetry.js';
import { logSafeDiagnostic, serializeDiagnostic } from '../../server/safeDiagnostics.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch16-unit-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DOTENV_CONFIG_PATH: '/dev/null',
  DATABASE_PATH: path.join(root, 'telemetry.db'),
  UPLOADS_DIR: path.join(root, 'uploads'),
});

let db: Database.Database;
let database: typeof import('../../server/database.js');
let authEvents: typeof import('../../server/authEvents.js');
let usageEvents: typeof import('../../server/usageEvents.js');

before(async () => {
  database = await import('../../server/database.js');
  authEvents = await import('../../server/authEvents.js');
  usageEvents = await import('../../server/usageEvents.js');
  database.initializeDatabase();
  db = database.getDb();
  db.prepare(`
    INSERT INTO users (id, username, display_name, email, password_hash, is_verified)
    VALUES (1, 'telemetry_user', 'Telemetry User', 'telemetry@test.invalid', 'fixture', 1)
  `).run();
});

beforeEach(() => {
  db?.exec('DELETE FROM usage_events; DELETE FROM auth_events; DELETE FROM client_errors;');
});

after(() => {
  db?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('route canonicalization has a finite output set and never retains path secrets', () => {
  const cases = new Map<unknown, string>([
    ['/', '/'],
    ['/settings?token=secret#fragment', '/settings'],
    ['/profile/alice@example.com', '/profile/:username'],
    ['/profile/alice%40example.com?token=secret', '/profile/:username'],
    ['/games/private-server-slug', '/games/:slug'],
    ['/messages/12345', '/messages/:conversationId'],
    ['/groups/99/', '/groups/:id'],
    ['/posts/token-value', '/posts/:id'],
    ['/unknown/alice@example.com/token', UNKNOWN_TELEMETRY_ROUTE],
    ['https://example.com/profile/alice', UNKNOWN_TELEMETRY_ROUTE],
    ['', '/'],
    [null, UNKNOWN_TELEMETRY_ROUTE],
    [{ pathname: '/admin' }, UNKNOWN_TELEMETRY_ROUTE],
  ]);

  const finiteOutputs = new Set<string>();
  for (const [input, expected] of cases) {
    const result = canonicalTelemetryRoute(input);
    assert.equal(result, expected);
    assert.doesNotMatch(result, /alice|example|secret|token-value|private-server/i);
    finiteOutputs.add(result);
  }
  assert.ok(finiteOutputs.size < cases.size);
});

test('safe diagnostics drop arbitrary strings, objects, URLs, paths, and invalid values', () => {
  const secret = 'victim@example.com?token=top-secret';
  const serialized = serializeDiagnostic({
    subsystem: secret,
    severity: 'invalid' as any,
    code: `/srv/private/${secret}`,
    httpStatus: 999,
    context: {
      errorCount: 3,
      itemsInserted: Number.POSITIVE_INFINITY,
      sourcesChecked: 9_999_999,
      request: { url: `https://example.test/${secret}` },
      token: secret,
    },
  });
  assert.deepEqual(serialized, {
    subsystem: 'server',
    severity: 'error',
    code: 'SERVER_REQUEST_FAILED',
    context: { errorCount: 3, sourcesChecked: 1_000_000 },
  });
  assert.doesNotMatch(JSON.stringify(serialized), /victim|top-secret|\/srv|example\.test/);

  const lines: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => { lines.push(values.join(' ')); };
  try {
    logSafeDiagnostic({ subsystem: 'email', severity: 'error', code: 'EMAIL_SEND_FAILED', context: { token: secret } });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /EMAIL_SEND_FAILED/);
  assert.doesNotMatch(lines[0], /victim|top-secret/);
});

test('auth metadata and reasons are event-specific allowlists', () => {
  assert.deepEqual(authEvents.sanitizeAuthEventMetadata('admin_report_update', {
    reportId: 7,
    status: 'resolved',
    username: 'private-user',
    email: 'private@example.com',
  }), { reportId: 7, status: 'resolved' });
  assert.deepEqual(authEvents.sanitizeAuthEventMetadata('admin_rss_source_fetch', {
    sourceId: 2,
    itemsInserted: 50_000,
    url: 'https://user:pass@example.com/private',
  }), { sourceId: 2, itemsInserted: 10_000 });
  assert.equal(authEvents.sanitizeAuthEventMetadata('login_failure', {
    attemptedUsername: 'private@example.com',
  }), undefined);

  authEvents.logAuthEvent({
    eventType: 'login_failure',
    success: false,
    reason: 'last_active_admin',
    ip: '1.2.3.4evil',
    userAgent: ` Browser\nInjected ${'x'.repeat(600)} `,
    meta: { attemptedUsername: 'private@example.com' },
  });
  const row = db.prepare(`
    SELECT reason, ip_address, user_agent, meta FROM auth_events ORDER BY id DESC LIMIT 1
  `).get() as any;
  assert.equal(row.reason, '');
  assert.equal(row.ip_address, '');
  assert.equal(row.meta, '');
  assert.equal(row.user_agent.length, 500);
  assert.doesNotMatch(row.user_agent, /[\r\n]/);
});

test('usage persistence revalidates every field at the database boundary', () => {
  usageEvents.logUsage({
    eventType: 'page_view',
    userId: -4,
    route: '/private/alice@example.com?token=secret',
    featureArea: 'private@example.com',
    errorCode: 'TOKEN_secret',
    metadata: { secret: 'private@example.com' },
  } as any);
  usageEvents.logUsage({
    eventType: 'rss_replenished',
    userId: 1,
    route: '/world',
    featureArea: 'world',
    errorCode: 'SERVER_ERROR',
    metadata: { sourcesChecked: 500, secret: 'private@example.com' },
  });

  const rows = db.prepare(`
    SELECT event_type, user_id, route, feature_area, error_code, metadata_json
    FROM usage_events ORDER BY id
  `).all() as any[];
  assert.deepEqual(rows[0], {
    event_type: 'page_view', user_id: null, route: '/other',
    feature_area: null, error_code: null, metadata_json: null,
  });
  assert.deepEqual(rows[1], {
    event_type: 'rss_replenished', user_id: 1, route: '/world',
    feature_area: 'world', error_code: 'SERVER_ERROR',
    metadata_json: JSON.stringify({ sourcesChecked: 20 }),
  });
});

test('retention configuration accepts only bounded finite positive integers', () => {
  assert.deepEqual(database.getTelemetryRetentionConfig({
    USAGE_EVENTS_RETENTION_DAYS: '7',
    AUTH_EVENTS_RETENTION_DAYS: '8',
    CLIENT_ERRORS_RETENTION_DAYS: '9',
    TELEMETRY_CLEANUP_BATCH_SIZE: '25',
    TELEMETRY_CLEANUP_INTERVAL_MINUTES: '2',
  }), { usageDays: 7, authDays: 8, clientDays: 9, batchSize: 25, intervalMinutes: 2 });

  assert.deepEqual(database.getTelemetryRetentionConfig({
    USAGE_EVENTS_RETENTION_DAYS: '0',
    AUTH_EVENTS_RETENTION_DAYS: '-1',
    CLIENT_ERRORS_RETENTION_DAYS: 'Infinity',
    TELEMETRY_CLEANUP_BATCH_SIZE: '1.5',
    TELEMETRY_CLEANUP_INTERVAL_MINUTES: '9999999999999999999999',
  }), {
    usageDays: database.TELEMETRY_RETENTION_DEFAULT_DAYS.usageEvents,
    authDays: database.TELEMETRY_RETENTION_DEFAULT_DAYS.authEvents,
    clientDays: database.TELEMETRY_RETENTION_DEFAULT_DAYS.clientErrors,
    batchSize: database.TELEMETRY_CLEANUP_DEFAULT_BATCH_SIZE,
    intervalMinutes: database.TELEMETRY_CLEANUP_DEFAULT_INTERVAL_MINUTES,
  });
});

test('cleanup is bounded, preserves recent telemetry, and never touches operational audit', () => {
  for (let index = 0; index < 3; index += 1) {
    db.prepare("INSERT INTO usage_events(event_type, created_at) VALUES ('page_view', datetime('now','-100 days'))").run();
    db.prepare("INSERT INTO auth_events(event_type, created_at) VALUES ('login_success', datetime('now','-200 days'))").run();
    db.prepare("INSERT INTO client_errors(error_message, created_at) VALUES ('legacy', datetime('now','-40 days'))").run();
  }
  db.prepare("INSERT INTO usage_events(event_type, created_at) VALUES ('page_view', datetime('now'))").run();
  db.prepare("INSERT INTO auth_events(event_type, created_at) VALUES ('login_success', datetime('now'))").run();
  db.prepare("INSERT INTO client_errors(error_message, created_at) VALUES ('recent', datetime('now'))").run();
  db.prepare("INSERT INTO operational_audit(event_type, target_type, target_id, created_at) VALUES ('fixture.event','fixture','1',datetime('now','-1000 days'))").run();

  const result = database.runTelemetryRetentionCleanup(db, { TELEMETRY_CLEANUP_BATCH_SIZE: '2' });
  assert.deepEqual(result, {
    deleted: { usage_events: 2, auth_events: 2, client_errors: 2 },
    failures: 0,
  });
  for (const table of ['usage_events', 'auth_events', 'client_errors']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as any).count, 2);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM operational_audit').get() as any).count, 1);
});

test('periodic cleanup runs during uptime and failures stay nonfatal', async () => {
  db.exec('DELETE FROM usage_events; DELETE FROM auth_events; DELETE FROM client_errors;');
  db.prepare("INSERT INTO usage_events(event_type, created_at) VALUES ('page_view', datetime('now','-100 days'))").run();
  db.prepare("INSERT INTO auth_events(event_type, created_at) VALUES ('login_success', datetime('now','-200 days'))").run();
  db.prepare("INSERT INTO client_errors(error_message, created_at) VALUES ('legacy', datetime('now','-40 days'))").run();
  const stop = database.startTelemetryRetentionScheduler({
    database: db,
    env: { TELEMETRY_CLEANUP_BATCH_SIZE: '10' },
    intervalMs: 10,
  });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const remaining = ['usage_events', 'auth_events', 'client_errors']
        .reduce((sum, table) => sum + (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as any).count, 0);
      if (remaining === 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    stop();
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM usage_events').get() as any).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM auth_events').get() as any).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM client_errors').get() as any).count, 0);

  const incomplete = new Database(':memory:');
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(database.runTelemetryRetentionCleanup(incomplete), {
      deleted: { usage_events: 0, auth_events: 0, client_errors: 0 },
      failures: 3,
    });
  } finally {
    console.error = original;
    incomplete.close();
  }
});

test('database initialization is forward-only and does not rewrite historical telemetry', () => {
  const historical = '/profile/private@example.com?token=legacy-secret';
  const id = Number(db.prepare(`
    INSERT INTO usage_events(event_type, route, metadata_json)
    VALUES ('page_view', ?, ?)
  `).run(historical, JSON.stringify({ legacyEmail: 'private@example.com' })).lastInsertRowid);
  database.initializeDatabase(db);
  assert.deepEqual(db.prepare('SELECT route, metadata_json FROM usage_events WHERE id = ?').get(id), {
    route: historical,
    metadata_json: JSON.stringify({ legacyEmail: 'private@example.com' }),
  });
});
