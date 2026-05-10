import type { Request, Response, NextFunction } from 'express';
import { verifyToken, getUserById } from './auth.js';

// Augment Express Request to include our user type
declare global {
  namespace Express {
    interface User {
      id: number;
      username: string;
      role: string;
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
  (req as any).user = { id: user.id, username: user.username, role: user.role };
  next();
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const payload = verifyToken(header.slice(7));
    if (payload) {
      const user = getUserById(payload.id);
      if (user && !user.banned) {
        (req as any).user = { id: user.id, username: user.username, role: user.role };
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
