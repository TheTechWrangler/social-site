import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/client';

const ROUTE_FEATURE_MAP: Record<string, string> = {
  '/': 'feed',
  '/discover': 'feed',
  '/world': 'world',
  '/games': 'games',
  '/groups': 'groups',
  '/friends': 'social',
  '/notifications': 'social',
  '/messages': 'messages',
  '/settings': 'account',
  '/admin': 'admin',
  '/profile': 'profile',
};

function getFeatureArea(pathname: string): string {
  for (const [prefix, area] of Object.entries(ROUTE_FEATURE_MAP)) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) return area;
  }
  return 'other';
}

export function usePageTracking() {
  const location = useLocation();
  useEffect(() => {
    // Debounce: don't fire on transient renders
    const timer = setTimeout(() => {
      const route = location.pathname.replace(/\/\d+/g, '/:id'); // anonymize numeric IDs
      api.trackPageView(route, getFeatureArea(location.pathname)).catch(() => {});
    }, 500);
    return () => clearTimeout(timer);
  }, [location.pathname]);
}
