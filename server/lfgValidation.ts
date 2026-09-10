import {
  booleanField,
  integerField,
  numberEnumField,
  stringField,
  validatedObjectBody,
  type RequestBody,
} from './requestValidation.js';

export const LFG_TITLE_MAX = 120;
export const LFG_BODY_MAX = 1000;
export const LFG_SHORT_FIELD_MAX = 80;
export const LFG_DURATION_HOURS = [1, 3, 6, 12, 24] as const;

export interface LfgMutableFields {
  title?: string;
  body?: string;
  platform?: string;
  playStyle?: string;
  desiredGroupSize?: number | null;
  micRequired?: boolean;
}

export interface LfgCreateInput extends Required<Omit<LfgMutableFields, 'desiredGroupSize'>> {
  desiredGroupSize: number | null;
  durationHours: typeof LFG_DURATION_HOURS[number];
}

export interface LfgPatchInput extends LfgMutableFields {
  isActive?: boolean;
}

const MUTABLE_FIELDS = ['title', 'body', 'platform', 'playStyle', 'desiredGroupSize', 'micRequired'] as const;

function parseMutableFields(body: RequestBody, requireTitle: boolean): LfgMutableFields {
  const parsed: LfgMutableFields = {};
  const title = stringField(body, 'title', {
    required: requireTitle,
    maxLength: LFG_TITLE_MAX,
    allowEmpty: false,
  });
  const bodyText = stringField(body, 'body', { maxLength: LFG_BODY_MAX, allowEmpty: true });
  const platform = stringField(body, 'platform', { maxLength: LFG_SHORT_FIELD_MAX, allowEmpty: true });
  const playStyle = stringField(body, 'playStyle', { maxLength: LFG_SHORT_FIELD_MAX, allowEmpty: true });
  const desiredGroupSize = integerField(body, 'desiredGroupSize', { min: 1, max: 100, nullable: true });
  const micRequired = booleanField(body, 'micRequired');

  if (title !== undefined) parsed.title = title;
  if (bodyText !== undefined) parsed.body = bodyText;
  if (platform !== undefined) parsed.platform = platform;
  if (playStyle !== undefined) parsed.playStyle = playStyle;
  if (desiredGroupSize !== undefined) parsed.desiredGroupSize = desiredGroupSize;
  if (micRequired !== undefined) parsed.micRequired = micRequired;
  return parsed;
}

export function validateLfgCreate(value: unknown): LfgCreateInput {
  const body = validatedObjectBody(value, [...MUTABLE_FIELDS, 'durationHours']);
  const fields = parseMutableFields(body, true);
  const durationHours = numberEnumField(body, 'durationHours', LFG_DURATION_HOURS) ?? 6;
  return {
    title: fields.title!,
    body: fields.body ?? '',
    platform: fields.platform ?? '',
    playStyle: fields.playStyle ?? '',
    desiredGroupSize: fields.desiredGroupSize ?? null,
    micRequired: fields.micRequired ?? false,
    durationHours,
  };
}

export function validateLfgPatch(value: unknown): LfgPatchInput {
  const body = validatedObjectBody(value, [...MUTABLE_FIELDS, 'isActive']);
  const fields: LfgPatchInput = parseMutableFields(body, false);
  const isActive = booleanField(body, 'isActive');
  if (isActive !== undefined) fields.isActive = isActive;
  return fields;
}

export function validateLfgExtend(value: unknown): { durationHours: typeof LFG_DURATION_HOURS[number] } {
  const body = validatedObjectBody(value, ['durationHours']);
  return { durationHours: numberEnumField(body, 'durationHours', LFG_DURATION_HOURS, { required: true })! };
}
