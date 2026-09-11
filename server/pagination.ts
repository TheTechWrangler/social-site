import { RequestValidationError } from './requestValidation.js';

/** Normalize untrusted pagination without permitting SQLite's negative LIMIT. */
export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

/** Strict public pagination contract. Internal legacy clamping remains separate. */
export function pageInteger(value: unknown, fallback: number, min: number, max: number, name = 'pagination'): number {
  if (value === undefined) return fallback;
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && !/^\d+$/.test(value))) {
    throw new RequestValidationError(`${name} must be an integer from ${min} to ${max}.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new RequestValidationError(`${name} must be an integer from ${min} to ${max}.`);
  return parsed;
}
