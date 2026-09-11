/** SQLite UTC and ISO dates share one ordering; invalid dates sort last. */
export function timestampOrder(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(value)) return 0;
  let normalized = value.replace(' ', 'T');
  if (!/(Z|[+-]\d\d:\d\d)$/i.test(normalized)) normalized += 'Z';
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
