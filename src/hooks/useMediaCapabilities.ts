import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { RouteRequestGate } from '../routeLoadState';

export interface FeatureAvailability {
  enabled: boolean;
  reason?: string;
}

export interface MediaCapabilities {
  imageUploads: FeatureAvailability;
  avatarUploads: FeatureAvailability;
  externalVideoEmbeds: FeatureAvailability;
  directVideoUploads: FeatureAvailability;
}

export type CapabilityLoadState = 'loading' | 'loaded' | 'error';

export function normalizeMediaCapabilities(value: unknown): MediaCapabilities | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const keys = ['imageUploads', 'avatarUploads', 'externalVideoEmbeds', 'directVideoUploads'] as const;
  const result = {} as MediaCapabilities;
  for (const key of keys) {
    const capability = source[key];
    if (!capability || typeof capability !== 'object' || typeof (capability as any).enabled !== 'boolean') return null;
    result[key] = {
      enabled: (capability as any).enabled,
      ...(typeof (capability as any).reason === 'string' ? { reason: (capability as any).reason } : {}),
    };
  }
  // Direct upload is deliberately not a discoverable/enabled Batch 16B feature.
  result.directVideoUploads = {
    enabled: false,
    reason: result.directVideoUploads.reason || 'Direct video upload is unavailable.',
  };
  return result;
}

export function useMediaCapabilities() {
  const [capabilities, setCapabilities] = useState<MediaCapabilities | null>(null);
  const [state, setState] = useState<CapabilityLoadState>('loading');
  const gate = useRef(new RouteRequestGate());

  const retry = useCallback(async () => {
    const isCurrent = gate.current.begin();
    setState('loading');
    try {
      const raw = await api.get<unknown>('/uploads/capabilities');
      const next = normalizeMediaCapabilities(raw);
      if (!next) throw new Error('Invalid capability response.');
      if (!isCurrent()) return;
      setCapabilities(next);
      setState('loaded');
    } catch {
      if (!isCurrent()) return;
      setCapabilities(null);
      setState('error');
    }
  }, []);

  useEffect(() => {
    void retry();
    return () => gate.current.invalidate();
  }, [retry]);

  return { capabilities, state, retry };
}
