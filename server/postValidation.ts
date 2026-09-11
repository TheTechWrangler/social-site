import {
  integerField,
  stringField,
  validatedObjectBody,
} from './requestValidation.js';

export const POST_MAX_LENGTH = 5000;

export interface PostEditInput {
  content: string;
  expectedEditVersion: number;
}

export function validatePostContent(value: unknown): string {
  const body = validatedObjectBody({ content: value }, ['content']);
  return stringField(body, 'content', {
    required: true,
    maxLength: POST_MAX_LENGTH,
    allowEmpty: false,
  })!;
}

export function validatePostEdit(value: unknown): PostEditInput {
  const body = validatedObjectBody(value, ['content', 'expectedEditVersion']);
  return {
    content: validatePostContent(body.content),
    expectedEditVersion: integerField(body, 'expectedEditVersion', {
      required: true,
      min: 0,
      max: Number.MAX_SAFE_INTEGER - 1,
    })!,
  };
}
