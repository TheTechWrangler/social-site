export type RouteLoadState = 'loading' | 'loaded' | 'unavailable' | 'error';

export interface HttpLikeError {
  status?: number;
}

export function routeFailureState(error: unknown): Exclude<RouteLoadState, 'loading' | 'loaded'> {
  const status = Number((error as HttpLikeError | null)?.status);
  return status === 403 || status === 404 ? 'unavailable' : 'error';
}

export function routeStateForKey(
  currentKey: string,
  stateKey: string,
  state: RouteLoadState,
): RouteLoadState {
  return currentKey === stateKey ? state : 'loading';
}

/**
 * Issues monotonically increasing request generations. A completion may commit
 * only while its generation remains current.
 */
export class RouteRequestGate {
  private generation = 0;

  begin(): () => boolean {
    const requestGeneration = ++this.generation;
    return () => requestGeneration === this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }
}
