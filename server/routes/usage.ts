/**
 * usage.ts — client-side event tracking endpoint.
 *
 * Privacy rules:
 * - Only page_view and client_error event types accepted from clients.
 * - Route is anonymized (IDs stripped) before storage.
 * - No message content, passwords, tokens, or form data ever stored.
 * - userId set from JWT only if token is present and valid.
 */
import { Router } from 'express';
import { optionalAuth, type AuthRequest } from '../middleware.js';
import { logUsage } from '../usageEvents.js';

const router = Router();

const ALLOWED_CLIENT_EVENTS = new Set(['page_view', 'client_error']);

// POST /api/usage/event
router.post('/event', optionalAuth, (req: AuthRequest, res) => {
  const { eventType, route, featureArea, errorCode } = req.body;

  if (!eventType || !ALLOWED_CLIENT_EVENTS.has(eventType)) {
    res.status(400).json({ error: 'Invalid event type.' });
    return;
  }

  // Sanitize route: strip query strings and fragment, anonymize numeric IDs
  let safeRoute: string | undefined;
  if (typeof route === 'string') {
    safeRoute = route
      .split('?')[0]
      .split('#')[0]
      .replace(/\/\d+/g, '/:id')
      .slice(0, 200);
  }

  // Whitelist feature areas
  const ALLOWED_AREAS = new Set(['feed', 'world', 'games', 'groups', 'social', 'messages', 'account', 'admin', 'profile', 'other']);
  const safeArea = typeof featureArea === 'string' && ALLOWED_AREAS.has(featureArea) ? featureArea : undefined;

  // Only store a safe generic error code
  const safeErrorCode = typeof errorCode === 'string' ? errorCode.slice(0, 50).replace(/[^A-Z0-9_]/gi, '_') : undefined;

  logUsage({
    eventType: eventType as 'page_view' | 'client_error',
    userId: req.user?.id ?? null,
    route: safeRoute,
    featureArea: safeArea,
    errorCode: safeErrorCode,
  });

  res.json({ ok: true });
});

export default router;
