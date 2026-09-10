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
const JWT_SECRET = 'isolated-batch08-jwt-secret-not-for-production';
let testRoot = '';
let databasePath = '';
let uploadsDir = '';
let baseUrl = '';
let server: ChildProcess | undefined;
let serverLog = '';
let db: Database.Database;
const users: Record<string, number> = {};
let conversationA = 0;
let conversationB = 0;

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

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server?.exitCode !== null) break;
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
    } catch {
      // Server is starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Isolated Batch 08 server did not start:\n' + serverLog.slice(-8000));
}

function cookie(username: string): string {
  return 'refugecloud_auth=' + jwt.sign({
    id: users[username],
    username,
    role: 'user',
    is_verified: 1,
  }, JWT_SECRET, { expiresIn: '10m' });
}

async function request(pathname: string, username: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set('cookie', cookie(username));
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers.set('origin', baseUrl);
  if (options.body) headers.set('content-type', 'application/json');
  const response = await fetch(baseUrl + pathname, { ...options, headers });
  const body = await response.json();
  return { response, body };
}

function insertConversation(first: number, second: number): number {
  const id = Number(db.prepare('INSERT INTO dm_conversations DEFAULT VALUES').run().lastInsertRowid);
  db.prepare('INSERT INTO dm_conversation_members (conversation_id, user_id) VALUES (?, ?)').run(id, first);
  db.prepare('INSERT INTO dm_conversation_members (conversation_id, user_id) VALUES (?, ?)').run(id, second);
  return id;
}

function insertMessage(conversationId: number, senderId: number, body: string): number {
  return Number(db.prepare(
    'INSERT INTO dm_messages (conversation_id, sender_id, body) VALUES (?, ?, ?)',
  ).run(conversationId, senderId, body).lastInsertRowid);
}

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch08-'));
  databasePath = path.join(testRoot, 'data', 'batch08.db');
  uploadsDir = path.join(testRoot, 'uploads');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  baseUrl = 'http://127.0.0.1:' + port;
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
      SESSION_SECRET: 'isolated-batch08-session-secret-not-for-production',
      APP_BASE_URL: baseUrl,
      WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      STEAM_API_KEY: '',
      STEAM_RETURN_URL: '',
      RESEND_API_KEY: '',
      RATE_LIMIT_ENABLED: 'false',
      CSRF_ENFORCE_IN_TESTS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  await waitForHealth();

  db = new Database(databasePath);
  const addUser = db.prepare(
    `INSERT INTO users
      (username, display_name, email, password_hash, is_verified, profile_visibility, dm_privacy)
     VALUES (?, ?, ?, 'isolated-test-hash', 1, 'public', 'everyone')`,
  );
  for (const username of ['alpha', 'beta', 'gamma', 'outsider']) {
    users[username] = Number(addUser.run(
      username,
      username.toUpperCase(),
      username + '@test.invalid',
    ).lastInsertRowid);
  }
  conversationA = insertConversation(users.alpha, users.beta);
  conversationB = insertConversation(users.alpha, users.gamma);
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
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-batch08-'))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

test('read marker advances only through the highest message actually fetched', async () => {
  const messageN = insertMessage(conversationA, users.beta, 'message N');
  const fetchedN = await request('/api/messages/' + conversationA, 'alpha');
  assert.equal(fetchedN.response.status, 200);
  assert.equal(fetchedN.body.messages.at(-1).id, messageN);

  const messageN1 = insertMessage(conversationA, users.beta, 'message N+1');
  const readN = await request('/api/messages/' + conversationA + '/read', 'alpha', {
    method: 'POST',
    body: JSON.stringify({ observedMessageId: messageN }),
  });
  assert.equal(readN.response.status, 200);
  assert.equal(readN.body.lastReadMessageId, messageN);
  assert.equal(
    (db.prepare(
      'SELECT last_read_message_id FROM dm_conversation_members WHERE conversation_id = ? AND user_id = ?',
    ).get(conversationA, users.alpha) as any).last_read_message_id,
    messageN,
  );

  const listWhileN1Unseen = await request('/api/messages', 'alpha');
  const previewA = listWhileN1Unseen.body.conversations.find((item: any) => item.id === conversationA);
  assert.equal(previewA.unreadCount, 1);

  const fetchedN1 = await request('/api/messages/' + conversationA, 'alpha');
  assert.equal(fetchedN1.body.messages.at(-1).id, messageN1);
  const readN1 = await request('/api/messages/' + conversationA + '/read', 'alpha', {
    method: 'POST',
    body: JSON.stringify({ observedMessageId: messageN1 }),
  });
  assert.equal(readN1.body.lastReadMessageId, messageN1);

  const staleRead = await request('/api/messages/' + conversationA + '/read', 'alpha', {
    method: 'POST',
    body: JSON.stringify({ observedMessageId: messageN }),
  });
  assert.equal(staleRead.body.lastReadMessageId, messageN1);
  const reconciled = await request('/api/messages', 'alpha');
  assert.equal(
    reconciled.body.conversations.find((item: any) => item.id === conversationA).unreadCount,
    0,
  );
});

test('read marker rejects another-conversation IDs and outsiders', async () => {
  const otherMessage = insertMessage(conversationB, users.gamma, 'other conversation');
  const wrongConversation = await request('/api/messages/' + conversationA + '/read', 'alpha', {
    method: 'POST',
    body: JSON.stringify({ observedMessageId: otherMessage }),
  });
  assert.equal(wrongConversation.response.status, 404);

  const outsider = await request('/api/messages/' + conversationA + '/read', 'outsider', {
    method: 'POST',
    body: JSON.stringify({ observedMessageId: otherMessage }),
  });
  assert.equal(outsider.response.status, 404);
});

test('a bounded thread refresh receives an incoming message without duplicate rows', async () => {
  const initial = await request('/api/messages/' + conversationA, 'alpha');
  const incoming = await request('/api/messages/' + conversationA, 'beta', {
    method: 'POST',
    body: JSON.stringify({ body: 'arrived while open' }),
  });
  assert.equal(incoming.response.status, 201);

  const firstRefresh = await request('/api/messages/' + conversationA, 'alpha');
  const secondRefresh = await request('/api/messages/' + conversationA, 'alpha');
  const firstIds = firstRefresh.body.messages.map((message: any) => message.id);
  const secondIds = secondRefresh.body.messages.map((message: any) => message.id);
  assert.equal(firstIds.includes(incoming.body.message.id), true);
  assert.equal(firstIds.filter((id: number) => id === incoming.body.message.id).length, 1);
  assert.equal(secondIds.filter((id: number) => id === incoming.body.message.id).length, 1);
  assert.ok(firstRefresh.body.messages.length >= initial.body.messages.length + 1);
});

test('incoming/outgoing previews reorder and deletion selects the next surviving message', async () => {
  const incoming = insertMessage(conversationB, users.gamma, 'incoming newest');
  let list = await request('/api/messages', 'alpha');
  assert.equal(list.body.conversations[0].id, conversationB);
  assert.equal(list.body.conversations[0].lastMessage.id, incoming);
  assert.equal(list.body.conversations[0].lastMessage.body, 'incoming newest');

  const sent = await request('/api/messages/' + conversationB, 'alpha', {
    method: 'POST',
    body: JSON.stringify({ body: 'outgoing newest' }),
  });
  assert.equal(sent.response.status, 201);
  const stored = db.prepare('SELECT conversation_id, sender_id FROM dm_messages WHERE id = ?')
    .get(sent.body.message.id) as any;
  assert.deepEqual(stored, { conversation_id: conversationB, sender_id: users.alpha });

  list = await request('/api/messages', 'alpha');
  assert.equal(list.body.conversations[0].lastMessage.body, 'outgoing newest');
  const deleted = await request(
    '/api/messages/' + conversationB + '/messages/' + sent.body.message.id,
    'alpha',
    { method: 'DELETE' },
  );
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.lastMessage.id, incoming);
  assert.equal(deleted.body.lastMessage.body, 'incoming newest');
});

