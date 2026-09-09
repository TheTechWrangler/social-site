import type { Request, Response } from 'express';

export const PASSPORT_SESSION_COOKIE_NAME = 'connect.sid';
const IS_PROD = process.env.NODE_ENV === 'production';

export function clearPassportSessionCookie(res: Response): void {
  res.clearCookie(PASSPORT_SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    path: '/',
  });
}

/** Fully terminate Passport authentication and its backing Express session. */
export function destroyBrowserSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    const destroySession = () => {
      const activeSession = (req as any).session;
      if (!activeSession || typeof activeSession.destroy !== 'function') {
        (req as any).user = undefined;
        resolve();
        return;
      }
      activeSession.destroy((err: Error | null) => {
        if (err) { reject(err); return; }
        (req as any).user = undefined;
        resolve();
      });
    };

    if (typeof (req as any).logout !== 'function') {
      destroySession();
      return;
    }
    (req as any).logout((err: Error | null) => {
      if (err) { reject(err); return; }
      destroySession();
    });
  });
}
