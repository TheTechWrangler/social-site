import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { downloadFeed, isPublicAddress, parseFeedXml, validateRssUrl } from '../../server/rssNetwork.js';
import { createRefreshCoordinator, RefreshBusyError } from '../../server/rssRefresh.js';

const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title><link>https://feed.example/</link><description>Test</description><item><title>One</title><guid>one</guid></item></channel></rss>';
let server: http.Server;
let port: number;
let connections = 0;
const observed: any[] = [];
before(async () => {
  server = http.createServer((req, res) => {
    connections++;
    const path = req.url!;
    if (path === '/private') { res.writeHead(302, { location: 'http://169.254.169.254/latest' }); res.end(); }
    else if (path === '/loop') { res.writeHead(302, { location: '/loop' }); res.end(); }
    else if (path.startsWith('/hop/')) { res.writeHead(302, { location: '/hop/' + (Number(path.split('/').at(-1)) + 1) }); res.end(); }
    else if (path === '/big') { res.write('x'.repeat(600)); res.end('x'.repeat(600)); }
    else if (path === '/length') { res.writeHead(200, { 'content-length': '3000000' }); res.end(); }
    else if (path === '/slow') { /* intentionally no headers */ }
    else if (path === '/slow-body') { res.writeHead(200, { 'content-type': 'application/xml' }); res.write('<rss>'); }
    else if (path === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>Not a feed</html>'); }
    else { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(rss); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as any).port;
});
after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

// Only this test transport maps public-shaped destinations to our owned fixture.
// Production has no environment/request switch that enables this mapping.
const transport = ((url: URL, options: any, callback: any) => {
  observed.push({ url: url.href, ...options });
  options.lookup(url.hostname, {}, (error: any, address: string, family: number) => {
    assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  return http.request(new URL(url.pathname, `http://127.0.0.1:${port}`), {
    ...options, lookup: undefined, servername: undefined,
    headers: { ...options.headers, Host: url.host },
  }, callback);
}) as typeof https.request;
const dependencies = { resolve: async () => [{ address: '8.8.8.8', family: 4 }], request: transport };

test('public HTTPS fixture uses pinned lookup, original host/SNI and enabled TLS verification', async () => {
  const body = await downloadFeed('https://feed.example/rss', dependencies);
  assert.equal((await parseFeedXml(body)).items.length, 1);
  const options = observed.at(-1);
  assert.equal(options.servername, 'feed.example');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.headers['Accept-Encoding'], 'identity');
  assert.equal(options.url, 'https://feed.example/rss');
});

test('URL and address policy rejects unsupported schemes, credentials and all non-public classes', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.31.0.1', '192.168.0.1', '169.254.169.254', '0.1.2.3', '100.64.0.1', '198.18.0.1', '192.0.2.1', '224.0.0.1', '255.255.255.255', '::', '::1', 'fc00::1', 'fd00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '2001:db8::1', '2002:7f00:1::']) {
    assert.equal(isPublicAddress(address), false, address);
    assert.throws(() => validateRssUrl(`http://${address.includes(':') ? '[' + address + ']' : address}/`), /public/, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('3fff::1'), false);
  assert.equal(isPublicAddress('5f00::1'), false);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['file:///etc/passwd', 'ftp://feed.example/', 'gopher://feed.example/', 'data:text/plain,test', 'javascript:alert(1)', 'blob:https://feed.example/a', 'https://user:secret@feed.example/', 'http://localhost/', 'http://127.1/', 'http://2130706433/']) assert.throws(() => validateRssUrl(url));
});

test('DNS checks every answer; private and mixed answers never reach the transport', async () => {
  const initial = connections;
  for (const addresses of [[{ address: '10.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }], []]) {
    await assert.rejects(downloadFeed('https://feed.example/', { ...dependencies, resolve: async () => addresses }), /public/);
  }
  assert.equal(connections, initial);
});

test('redirect to metadata-shaped private address is rejected without connecting to it', async () => {
  const initial = connections;
  await assert.rejects(downloadFeed('https://feed.example/private', dependencies), /public/);
  assert.equal(connections, initial + 1);
});

test('redirect loops and hop counts are bounded', async () => {
  await assert.rejects(downloadFeed('https://feed.example/loop', dependencies), /loop/);
  const initial = connections;
  await assert.rejects(downloadFeed('https://feed.example/hop/0', dependencies), /redirect limit/);
  assert.equal(connections, initial + 6);
});

test('DNS is revalidated on a same-host redirect and cannot rebind private', async () => {
  let resolutions = 0;
  const initial = connections;
  await assert.rejects(downloadFeed('https://feed.example/hop/0', {
    ...dependencies, resolve: async () => [{ address: ++resolutions === 1 ? '8.8.8.8' : '10.0.0.1', family: 4 }],
  }), /public/);
  assert.equal(resolutions, 2);
  assert.equal(connections, initial + 1);
});

test('real local TLS fixture rejects an untrusted certificate and verifies a trusted original hostname', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch14-tls-'));
  let fixture: https.Server | undefined;
  try {
    const keyPath = path.join(root, 'key.pem'), certPath = path.join(root, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=feed.example', '-days', '1'], { stdio: 'ignore' });
    const certificate = fs.readFileSync(certPath);
    fixture = https.createServer({ key: fs.readFileSync(keyPath), cert: certificate }, (_req, res) => res.end(rss));
    await new Promise<void>(resolve => fixture!.listen(0, '127.0.0.1', resolve));
    const fixturePort = (fixture.address() as any).port;
    const tlsTransport = (trust: boolean) => ((url: URL, options: any, callback: any) => {
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.servername, 'feed.example');
      const target = new URL(url); target.port = String(fixturePort);
      return https.request(target, { ...options, ...(trust ? { ca: certificate } : {}),
        lookup: (_host: any, _options: any, done: any) => done(null, '127.0.0.1', 4),
      }, callback);
    }) as typeof https.request;
    await assert.rejects(downloadFeed('https://feed.example/', { ...dependencies, request: tlsTransport(false) }), /connection failed/);
    assert.equal(await downloadFeed('https://feed.example/', { ...dependencies, request: tlsTransport(true) }), rss);
  } finally {
    fixture?.closeAllConnections();
    if (fixture) await new Promise<void>(resolve => fixture!.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('DNS, headers and slow-body deadlines terminate without an unbounded buffer', async () => {
  await assert.rejects(downloadFeed('https://feed.example/', { ...dependencies, resolve: () => new Promise(() => {}), limits: { overallMs: 30 } }), /timed out/);
  for (const path of ['/slow', '/slow-body']) {
    const start = Date.now();
    await assert.rejects(downloadFeed('https://feed.example' + path, { ...dependencies, limits: { overallMs: 150, headersMs: 60, idleMs: 60 } }), /timed out/);
    assert.ok(Date.now() - start < 1000);
  }
});

test('chunked and declared oversized responses are rejected while streaming', async () => {
  await assert.rejects(downloadFeed('https://feed.example/big', { ...dependencies, limits: { bytes: 1000 } }), /byte limit/);
  await assert.rejects(downloadFeed('https://feed.example/length', dependencies), /byte limit/);
});

test('valid Atom accepted; HTML, malformed XML, DTD and non-feeds rejected', async () => {
  const atom = await parseFeedXml('<feed xmlns="http://www.w3.org/2005/Atom"><title>Test</title><entry><id>a</id><title>Entry</title></entry></feed>');
  assert.equal(atom.items.length, 1);
  for (const body of ['<rss><channel>', '<html><body>not a feed</body></html>', 'not XML', '<!DOCTYPE rss><rss/>']) await assert.rejects(parseFeedXml(body));
  await assert.rejects(downloadFeed('https://feed.example/html', dependencies), /supported XML/);
});

test('same-feed refreshes coalesce; global capacity and cooldown bound repeated work', async () => {
  const run = createRefreshCoordinator(1, 1000);
  let calls = 0; let finish!: (value: number) => void;
  const work = () => { calls++; return new Promise<number>(resolve => { finish = resolve; }); };
  const first = run(1, work); const retry = run(1, work);
  assert.equal(first, retry);
  await assert.rejects(run(2, async () => 2), RefreshBusyError);
  await Promise.resolve(); finish(7);
  assert.equal(await first, 7); assert.equal(await retry, 7);
  assert.equal(await run(1, work), 7); assert.equal(calls, 1);
  assert.equal(await run(2, async () => 2), 2);
});
