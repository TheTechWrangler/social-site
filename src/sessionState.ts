import { ApiError } from './api/client';

export type SessionFailureOutcome = 'anonymous' | 'retry';

export function sessionFailureOutcome(error: unknown): SessionFailureOutcome {
  return error instanceof ApiError && error.kind === 'http' && (error.status === 401 || error.status === 403)
    ? 'anonymous' : 'retry';
}

export function sessionUserFromResponse(response: unknown): any {
  const user = response && typeof response === 'object' ? (response as any).user : null;
  if (
    !user || typeof user !== 'object' ||
    !Number.isSafeInteger(user.id) || user.id <= 0 ||
    typeof user.username !== 'string' || !user.username.trim() ||
    typeof user.role !== 'string' || !user.role.trim()
  ) {
    throw new ApiError('The server returned an unexpected session response.', {
      kind: 'invalid-response',
    });
  }
  return user;
}
