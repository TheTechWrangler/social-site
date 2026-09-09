import assert from 'node:assert/strict';
import test from 'node:test';
import { api, ApiError, request } from '../../src/api/client.js';
import {
  attachComposerMedia,
  SubmissionLock,
  submitComposerPost,
} from '../../src/postComposerSubmission.js';

async function withFetch(
  implementation: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('checked requests classify HTTP status, network, and malformed responses', async () => {
  for (const status of [400, 401, 403, 404, 429, 500]) {
    await withFetch(async () => new Response(
      JSON.stringify({ error: `safe error ${status}` }),
      { status, headers: { 'Content-Type': 'application/json' } },
    ), async () => {
      await assert.rejects(
        request('/mutation', { method: 'DELETE' }),
        (error: unknown) => {
          assert.ok(error instanceof ApiError);
          assert.equal(error.kind, 'http');
          assert.equal(error.status, status);
          assert.equal(error.message, `safe error ${status}`);
          assert.equal(error.malformedResponse, false);
          return true;
        },
      );
    });
  }

  await withFetch(async () => { throw new TypeError('offline'); }, async () => {
    await assert.rejects(request('/mutation', { method: 'POST' }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, 'network');
      assert.equal(error.status, undefined);
      return true;
    });
  });

  await withFetch(async () => new Response('<html>denied</html>', { status: 500 }), async () => {
    await assert.rejects(request('/mutation'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, 'http');
      assert.equal(error.status, 500);
      assert.equal(error.malformedResponse, true);
      return true;
    });
  });

  await withFetch(async () => new Response('not json', { status: 200 }), async () => {
    await assert.rejects(request('/mutation'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.kind, 'invalid-response');
      return true;
    });
  });
});

test('checked requests support JSON and empty successful mutation responses', async () => {
  await withFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }), async () => {
    assert.deepEqual(await request('/mutation', { method: 'PATCH' }), { ok: true });
  });
  await withFetch(async () => new Response(null, { status: 204 }), async () => {
    assert.equal(await request('/mutation', { method: 'DELETE' }), undefined);
  });
});

test('multipart mutations use the checked request path without forcing a content type', async () => {
  let captured: RequestInit | undefined;
  await withFetch(async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ media: { id: 7 } }), { status: 201 });
  }, async () => {
    const file = new Blob(['image bytes'], { type: 'image/png' }) as File;
    const result = await api.uploadImage(file, 42);
    assert.equal(result.media.id, 7);
  });
  assert.equal(captured?.method, 'POST');
  assert.ok(captured?.body instanceof FormData);
  assert.equal((captured?.body as FormData).get('postId'), '42');
  assert.deepEqual(captured?.headers, {});
});

test('successful composer workflow returns its post ID and both attachments', async () => {
  const result = await submitComposerPost('hello', {
    imageFile: {} as File,
    youtubeUrl: 'https://youtu.be/abcdefghijk',
  }, {
    createPost: async () => ({ post: { id: 99 } }),
    uploadImage: async () => undefined,
    attachYouTube: async () => undefined,
  });
  assert.equal(result.postId, 99);
  assert.deepEqual(result.attached, ['image', 'video']);
  assert.deepEqual(result.failures, []);
});

test('rejected mutations cannot advance representative local state', async () => {
  const cases = ['delete', 'reaction', 'unblock', 'lfg', 'admin'];
  for (const operation of cases) {
    let committed = false;
    const draft = { name: 'preserve me' };
    await withFetch(async () => new Response(
      JSON.stringify({ error: `${operation} rejected` }),
      { status: 403 },
    ), async () => {
      try {
        await request('/mutation', { method: 'POST' });
        committed = true;
        draft.name = '';
      } catch (error) {
        assert.ok(error instanceof ApiError);
      }
    });
    assert.equal(committed, false, `${operation} must not commit local success state`);
    assert.equal(draft.name, 'preserve me', `${operation} must preserve user state`);
  }
});

test('post creation failure preserves the complete composer draft', async () => {
  const imageFile = {} as File;
  const draft = { imageFile, youtubeUrl: 'https://youtu.be/abcdefghijk' };
  let uploadCalls = 0;
  await assert.rejects(submitComposerPost('draft text', draft, {
    createPost: async () => { throw new Error('create rejected'); },
    uploadImage: async () => { uploadCalls += 1; },
    attachYouTube: async () => { uploadCalls += 1; },
  }), /create rejected/);
  assert.equal(uploadCalls, 0);
  assert.equal(draft.imageFile, imageFile);
  assert.equal(draft.youtubeUrl, 'https://youtu.be/abcdefghijk');
});

test('attachment failures report partial success and retry without creating another post', async () => {
  const imageFile = {} as File;
  let createCalls = 0;
  let imageCalls = 0;
  let videoCalls = 0;
  const first = await submitComposerPost('hello', {
    imageFile,
    youtubeUrl: 'https://youtu.be/abcdefghijk',
  }, {
    createPost: async () => {
      createCalls += 1;
      return { post: { id: 321 } };
    },
    uploadImage: async () => {
      imageCalls += 1;
      throw new Error('image failed');
    },
    attachYouTube: async () => {
      videoCalls += 1;
      throw new Error('video failed');
    },
  });
  assert.equal(first.postId, 321);
  assert.deepEqual(first.attached, []);
  assert.deepEqual(first.failures.map(f => f.kind), ['image', 'video']);

  const retry = await attachComposerMedia(321, {
    imageFile,
    youtubeUrl: 'https://youtu.be/abcdefghijk',
  }, {
    uploadImage: async (_file, postId) => {
      imageCalls += 1;
      assert.equal(postId, 321);
    },
    attachYouTube: async (_url, postId) => {
      videoCalls += 1;
      assert.equal(postId, 321);
    },
  });
  assert.equal(createCalls, 1);
  assert.deepEqual(retry.attached, ['image', 'video']);
  assert.deepEqual(retry.failures, []);
  assert.equal(imageCalls, 2);
  assert.equal(videoCalls, 2);
});

test('submission lock rejects same-tick duplicate submissions and releases for retry', () => {
  const lock = new SubmissionLock();
  assert.equal(lock.tryAcquire(), true);
  assert.equal(lock.tryAcquire(), false);
  lock.release();
  assert.equal(lock.tryAcquire(), true);
});
