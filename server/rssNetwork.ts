import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import Parser from 'rss-parser';

export class RssFetchError extends Error {}
export const RSS_LIMITS = { bytes: 2 * 1024 * 1024, redirects: 5, overallMs: 15000, connectMs: 3000, headersMs: 5000, idleMs: 5000 };

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  // Only currently allocated global unicast IPv6; exclude transition tunnels.
  return parsed.kind() === 'ipv4' || (
    (parsed as ipaddr.IPv6).match(ipaddr.parse('2000::') as ipaddr.IPv6, 3) &&
    // RFC 9637 documentation range postdates ipaddr.js 2.2's registry.
    !(parsed as ipaddr.IPv6).match(ipaddr.parse('3fff::') as ipaddr.IPv6, 20)
  );
}

export function validateRssUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new RssFetchError('Invalid feed URL.'); }
  if (value.length > 2048 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new RssFetchError('Feed URL must use HTTP or HTTPS without credentials.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || (isIP(host) && !isPublicAddress(host))) {
    throw new RssFetchError('Feed destination is not a public network address.');
  }
  url.hash = '';
  return url;
}

type Address = { address: string; family: number };
// Dependency injection is code-only, used by controlled fixtures, never request/config data.
export interface RssNetworkDependencies {
  resolve?: (hostname: string) => Promise<Address[]>;
  request?: typeof https.request;
  limits?: Partial<typeof RSS_LIMITS>;
}

export async function downloadFeed(value: string, dependencies: RssNetworkDependencies = {}): Promise<string> {
  const limits = { ...RSS_LIMITS, ...dependencies.limits };
  const controller = new AbortController();
  const timeout = new RssFetchError('Feed request timed out.');
  const overall = setTimeout(() => controller.abort(timeout), limits.overallMs);
  const visited = new Set<string>();
  const resolve = dependencies.resolve ?? (host => lookup(host, { all: true, verbatim: true }));
  try {
    let url = validateRssUrl(value);
    for (let hop = 0; ; hop++) {
      if (controller.signal.aborted) throw timeout;
      if (visited.has(url.href)) throw new RssFetchError('Feed redirect loop.');
      visited.add(url.href);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await new Promise<Address[]>((accept, reject) => {
        const abort = () => reject(timeout);
        controller.signal.addEventListener('abort', abort, { once: true });
        const pending = isIP(hostname) ? Promise.resolve([{ address: hostname, family: isIP(hostname) }]) : resolve(hostname);
        pending.then(accept, () => reject(new RssFetchError('Feed DNS resolution failed.')))
          .finally(() => controller.signal.removeEventListener('abort', abort));
      });
      if (controller.signal.aborted) throw timeout;
      if (!addresses.length || addresses.some(a => !isPublicAddress(a.address) || isIP(a.address) !== a.family)) {
        throw new RssFetchError('Feed DNS destination is not a public network address.');
      }
      const selected = addresses[0];
      const result = await new Promise<{ location?: string; body?: string }>((accept, reject) => {
        let settled = false;
        let request: http.ClientRequest | undefined;
        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        const finish = (error?: Error, result?: { location?: string; body?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(headersTimer); clearTimeout(connectTimer);
          if (error) { reject(controller.signal.aborted ? timeout : error); request?.destroy(); } else accept(result!);
        };
        const headersTimer = setTimeout(() => finish(timeout), limits.headersMs);
        const transport = dependencies.request ?? (url.protocol === 'https:' ? https.request : http.request);
        try {
        request = transport(url, {
          agent: false, signal: controller.signal, family: selected.family,
          // No second DNS lookup: connect only to the validated address. URL host
          // remains the HTTP Host and TLS certificate/SNI identity.
          lookup: ((_host: string, options: any, callback: any) => options?.all
            ? callback(null, [selected]) : callback(null, selected.address, selected.family)) as any,
          servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true,
          maxHeaderSize: 16384,
          headers: { 'User-Agent': 'RefugeCloud/0.1 Feed Reader', 'Accept-Encoding': 'identity', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/plain' },
        }, response => {
          clearTimeout(headersTimer); clearTimeout(connectTimer);
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            const location = response.headers.location;
            response.destroy();
            return location ? finish(undefined, { location }) : finish(new RssFetchError('Feed redirect has no destination.'));
          }
          const contentType = (response.headers['content-type'] ?? '').toLowerCase();
          if (response.statusCode !== 200) { response.destroy(); return finish(new RssFetchError('Feed server returned an unsuccessful status.')); }
          if (/^(text\/html|application\/json|image\/|audio\/|video\/)/.test(contentType) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            response.destroy(); return finish(new RssFetchError('Feed response is not supported XML.'));
          }
          if (Number(response.headers['content-length']) > limits.bytes) { response.destroy(); return finish(new RssFetchError('Feed response exceeds the byte limit.')); }
          const chunks: Buffer[] = []; let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > limits.bytes) { finish(new RssFetchError('Feed response exceeds the byte limit.')); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on('end', () => finish(undefined, { body: Buffer.concat(chunks).toString('utf8') }));
          response.on('error', () => finish(new RssFetchError('Feed response was interrupted.')));
          response.on('aborted', () => finish(new RssFetchError('Feed response was interrupted.')));
        });
        request.on('socket', socket => {
          connectTimer = setTimeout(() => finish(timeout), limits.connectMs);
          socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
        });
        request.setTimeout(limits.idleMs, () => finish(timeout));
        request.on('error', () => finish(controller.signal.aborted ? timeout : new RssFetchError('Feed connection failed.')));
        request.end();
        } catch { finish(new RssFetchError('Feed connection failed.')); }
      });
      if (result.location) {
        if (hop >= limits.redirects) throw new RssFetchError('Feed redirect limit exceeded.');
        try { url = validateRssUrl(new URL(result.location, url).href); }
        catch (error) { throw error instanceof RssFetchError ? error : new RssFetchError('Invalid feed redirect.'); }
      } else return result.body!;
    }
  } finally { clearTimeout(overall); }
}

export async function parseFeedXml(body: string) {
  if (Buffer.byteLength(body) > RSS_LIMITS.bytes || /<!DOCTYPE|<!ENTITY/i.test(body)) throw new RssFetchError('Feed XML exceeds supported limits.');
  try {
    const feed = await new Parser().parseString(body);
    if ((feed.items?.length ?? 0) > 500) throw new RssFetchError('Feed contains more than 500 items.');
    return feed;
  } catch (error) { throw error instanceof RssFetchError ? error : new RssFetchError('Feed response is not valid RSS or Atom.'); }
}
