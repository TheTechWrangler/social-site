import type { Request, Response, NextFunction } from 'express';
import { verifyToken, getUserById } from './auth.js';

declare global {
  namespace Express {
    interface User {
      id: number;
      username: string;
      role: string;
      is_verified: number;
      profile_visibility: string;
      game_discovery_enabled: number;
    }
  }
}

export type AuthRequest = Request;

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  const token = header.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token.' });
    return;
  }
  const user = getUserById(payload.id);
  if (!user || user.banned) {
    res.status(403).json({ error: 'Account banned or not found.' });
    return;
  }
  (req as any).user = {
    id: user.id,
    username: user.username,
    role: user.role,
    is_verified: user.is_verified,
    game_discovery_enabled: user.game_discovery_enabled,
  };
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const payload = verifyToken(header.slice(7));
    if (payload) {
      const user = getUserById(payload.id);
      if (user && !user.banned) {
        (req as any).user = {
          id: user.id,
          username: user.username,
          role: user.role,
          is_verified: user.is_verified,
          game_discovery_enabled: user.game_discovery_enabled,
        };
      }
    }
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required.' });
    return;
  }
  next();
}

export function requireVerified(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user;
  if (!user) { res.status(401).json({ error: 'Authentication required.' }); return; }
  if (user.role === 'admin') { next(); return; }
  if (!user.is_verified) {
    res.status(403).json({ error: 'Account verification required before you can interact.' });
    return;
  }
  next();
}
