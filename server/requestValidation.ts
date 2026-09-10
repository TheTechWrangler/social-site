export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestValidationError';
  }
}

export type RequestBody = Record<string, unknown>;

export function validatedObjectBody(
  value: unknown,
  allowedKeys: readonly string[],
  options: { allowEmpty?: boolean } = {},
): RequestBody {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError('Request body must be a JSON object.');
  }

  const body = value as RequestBody;
  const keys = Object.keys(body);
  const unknownKey = keys.find(key => !allowedKeys.includes(key));
  if (unknownKey) {
    throw new RequestValidationError(`Unknown field: ${unknownKey}.`);
  }
  if (!options.allowEmpty && keys.length === 0) {
    throw new RequestValidationError('At least one field is required.');
  }
  return body;
}

export function hasField(body: RequestBody, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

export function stringField(
  body: RequestBody,
  key: string,
  options: { required?: boolean; maxLength: number; allowEmpty?: boolean; nullable: true },
): string | null | undefined;
export function stringField(
  body: RequestBody,
  key: string,
  options: { required?: boolean; maxLength: number; allowEmpty?: boolean; nullable?: false },
): string | undefined;
export function stringField(
  body: RequestBody,
  key: string,
  options: { required?: boolean; maxLength: number; allowEmpty?: boolean; nullable?: boolean },
): string | null | undefined {
  if (!hasField(body, key)) {
    if (options.required) throw new RequestValidationError(`${key} is required.`);
    return undefined;
  }

  const value = body[key];
  if (value === null) {
    if (options.nullable) return null;
    throw new RequestValidationError(`${key} cannot be null.`);
  }
  if (typeof value !== 'string') {
    throw new RequestValidationError(`${key} must be a string.`);
  }

  const trimmed = value.trim();
  if (!options.allowEmpty && trimmed.length === 0) {
    throw new RequestValidationError(`${key} cannot be empty.`);
  }
  if (trimmed.length > options.maxLength) {
    throw new RequestValidationError(`${key} must be ${options.maxLength} characters or fewer.`);
  }
  return trimmed;
}

export function integerField(
  body: RequestBody,
  key: string,
  options: { required?: boolean; min: number; max: number; nullable: true },
): number | null | undefined;
export function integerField(
  body: RequestBody,
  key: string,
  options: { required?: boolean; min: number; max: number; nullable?: false },
): number | undefined;
export function integerField(
  body: RequestBody,
  key: string,
  options: { required?: boolean; min: number; max: number; nullable?: boolean },
): number | null | undefined {
  if (!hasField(body, key)) {
    if (options.required) throw new RequestValidationError(`${key} is required.`);
    return undefined;
  }

  const value = body[key];
  if (value === null) {
    if (options.nullable) return null;
    throw new RequestValidationError(`${key} cannot be null.`);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < options.min || value > options.max) {
    throw new RequestValidationError(`${key} must be an integer from ${options.min} to ${options.max}.`);
  }
  return value;
}

export function booleanField(
  body: RequestBody,
  key: string,
  options: { required?: boolean } = {},
): boolean | undefined {
  if (!hasField(body, key)) {
    if (options.required) throw new RequestValidationError(`${key} is required.`);
    return undefined;
  }
  if (typeof body[key] !== 'boolean') {
    throw new RequestValidationError(`${key} must be a boolean.`);
  }
  return body[key];
}

export function enumField<const T extends string>(
  body: RequestBody,
  key: string,
  allowedValues: readonly T[],
  options: { required?: boolean } = {},
): T | undefined {
  if (!hasField(body, key)) {
    if (options.required) throw new RequestValidationError(`${key} is required.`);
    return undefined;
  }
  const value = body[key];
  if (typeof value !== 'string' || !allowedValues.includes(value as T)) {
    throw new RequestValidationError(`${key} must be one of: ${allowedValues.join(', ')}.`);
  }
  return value as T;
}

export function numberEnumField<const T extends number>(
  body: RequestBody,
  key: string,
  allowedValues: readonly T[],
  options: { required?: boolean } = {},
): T | undefined {
  if (!hasField(body, key)) {
    if (options.required) throw new RequestValidationError(`${key} is required.`);
    return undefined;
  }
  const value = body[key];
  if (typeof value !== 'number' || !allowedValues.includes(value as T)) {
    throw new RequestValidationError(`${key} must be one of: ${allowedValues.join(', ')}.`);
  }
  return value as T;
}

export function positiveIntegerParam(value: string, name = 'id'): number {
  if (!/^\d+$/.test(value)) {
    throw new RequestValidationError(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new RequestValidationError(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function validationErrorMessage(error: unknown): string | null {
  return error instanceof RequestValidationError ? error.message : null;
}
