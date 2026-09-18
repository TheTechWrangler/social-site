import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
let temporaryRoot = '';
let baseUrl = '';
let server: ChildProcess | undefined;
let serverLog = '';

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

before(async () => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-youtube-embed-'));
  const databasePath = path.join(temporaryRoot, 'data', 'test.db');
  const uploadsDir = path.join(temporaryRoot, 'uploads');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(path.join(ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', PORT: String(port),
      DATABASE_PATH: databasePath, UPLOADS_DIR: uploadsDir, JWT_SECRET: 'youtube-embed-test-jwt',
      SESSION_SECRET: 'youtube-embed-test-session', APP_BASE_URL: baseUrl, WEB_BASE_URL: baseUrl,
      RATE_LIMIT_ENABLED: 'false', RESEND_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(baseUrl + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(serverLog || 'Isolated server did not start.');
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server!.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  assert.ok(temporaryRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-youtube-embed-')));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('HTTP policy sends an origin-only referrer and retains the narrow YouTube frame allowlist', async () => {
  const response = await fetch(baseUrl + '/api/health');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.notEqual(response.headers.get('referrer-policy'), 'no-referrer');
  const csp = response.headers.get('content-security-policy') || '';
  assert.match(csp, /frame-src https:\/\/www\.youtube\.com https:\/\/www\.youtube-nocookie\.com/);
  assert.doesNotMatch(csp, /frame-src \*/);
});
