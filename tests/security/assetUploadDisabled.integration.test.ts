import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const PRODUCTION_UPLOADS = path.join(PROJECT_ROOT, 'uploads');

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

test('disabled image uploads reject before creating files or asset rows', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-disabled-upload-'));
  const databasePath = path.join(root, 'data', 'test.db');
  const uploadsDir = path.join(root, 'uploads');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
  assert.notEqual(path.resolve(uploadsDir), path.resolve(PRODUCTION_UPLOADS));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secret = 'disabled-upload-isolated-secret';
  let server: ChildProcess | undefined;
  let log = '';
  try {
    server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', PORT: String(port),
        DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir, JWT_SECRET: secret,
        SESSION_SECRET: 'disabled-upload-session', APP_BASE_URL: baseUrl, WEB_BASE_URL: baseUrl,
        ENABLE_IMAGE_UPLOADS: 'false', RATE_LIMIT_ENABLED: 'false',
        GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', STEAM_API_KEY: '', RESEND_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout?.on('data', chunk => { log += String(chunk); });
    server.stderr?.on('data', chunk => { log += String(chunk); });
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${baseUrl}/api/health`)).ok) break; } catch { /* starting */ }
      if (i === 99) throw new Error(`Server failed to start: ${log}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const db = new Database(databasePath);
    const userId = Number(db.prepare(`INSERT INTO users
      (username, display_name, email, password_hash, is_verified)
      VALUES ('disabledtest', 'Disabled Test', 'disabled@test.invalid', 'x', 1)`).run().lastInsertRowid);
    const token = jwt.sign({ id: userId, username: 'disabledtest', role: 'user', is_verified: 1 }, secret, { expiresIn: '5m' });
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex')], { type: 'image/png' }), 'image.png');
    const response = await fetch(`${baseUrl}/api/uploads/image`, {
      method: 'POST', headers: { cookie: `refugecloud_auth=${token}` }, body: form,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(fs.readdirSync(uploadsDir), []);
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM managed_assets').get() as any).c, 0);

    const postId = Number(db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(userId, 'disabled target').lastInsertRowid);
    const assetId = 'a'.repeat(32);
    const storageKey = `asset-${'a'.repeat(32)}.png`;
    db.prepare(`INSERT INTO managed_assets
      (id, owner_user_id, storage_key, url, media_type, mime_type, file_size_bytes, sha256, purpose, state, created_at_ms, pending_expires_at_ms)
      VALUES (?, ?, ?, ?, 'image', 'image/png', 24, ?, 'pending_post_image', 'pending', ?, ?)`)
      .run(assetId, userId, storageKey, `/uploads/${storageKey}`, '0'.repeat(64), Date.now(), Date.now() + 60000);
    const attach = await fetch(`${baseUrl}/api/uploads/assets/${assetId}/attach`, {
      method: 'POST', headers: { cookie: `refugecloud_auth=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ postId }),
    });
    assert.equal(attach.status, 403);
    assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(assetId) as any).state, 'pending');
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM post_media WHERE asset_id = ?').get(assetId) as any).c, 0);
    db.close();
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(resolve => server!.once('exit', resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
