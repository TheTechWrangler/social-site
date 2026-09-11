/** Process-local bounded single-flight coordinator; shared by every RSS entry point. */
export class RefreshBusyError extends Error {}
export function createRefreshCoordinator(maxActive = 4, cooldownMs = 60000) {
  const active = new Map<string | number, Promise<unknown>>();
  const recent = new Map<string | number, { until: number; value: unknown }>();
  return function run<T>(id: string | number, work: () => Promise<T>): Promise<T> {
    if (active.has(id)) return active.get(id) as Promise<T>;
    const cached = recent.get(id);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value as T);
    if (active.size >= maxActive) return Promise.reject(new RefreshBusyError('RSS refresh capacity is busy; retry later.'));
    const promise = Promise.resolve().then(work).then(value => {
      recent.delete(id);
      recent.set(id, { until: Date.now() + cooldownMs, value });
      if (recent.size > 200) recent.delete(recent.keys().next().value!);
      return value;
    }).finally(() => active.delete(id));
    active.set(id, promise);
    return promise;
  };
}
