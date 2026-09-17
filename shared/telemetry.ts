export const UNKNOWN_TELEMETRY_ROUTE = '/other';

const STATIC_ROUTES = new Set([
  '/', '/admin', '/discover', '/friends', '/games', '/groups', '/login',
  '/messages', '/notifications', '/oauth/callback', '/register',
  '/reset-password', '/settings', '/verify-email', '/world',
]);

const DYNAMIC_ROUTES: Array<{ pattern: RegExp; template: string }> = [
  { pattern: /^\/profile\/[^/]+\/?$/, template: '/profile/:username' },
  { pattern: /^\/games\/[^/]+\/?$/, template: '/games/:slug' },
  { pattern: /^\/messages\/[^/]+\/?$/, template: '/messages/:conversationId' },
  { pattern: /^\/groups\/[^/]+\/?$/, template: '/groups/:id' },
  { pattern: /^\/posts\/[^/]+\/?$/, template: '/posts/:id' },
];

/** Maps a browser or client supplied location to a finite, non-identifying route. */
export function canonicalTelemetryRoute(input: unknown): string {
  if (typeof input !== 'string') return UNKNOWN_TELEMETRY_ROUTE;
  const path = input.split(/[?#]/, 1)[0] || '/';
  const normalized = path.length > 1 ? path.replace(/\/+$/, '') : path;
  if (STATIC_ROUTES.has(normalized)) return normalized;
  for (const route of DYNAMIC_ROUTES) {
    if (route.pattern.test(normalized)) return route.template;
  }
  return UNKNOWN_TELEMETRY_ROUTE;
}
