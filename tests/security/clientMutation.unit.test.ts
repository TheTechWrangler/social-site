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

test('multipart upload creates a pending asset without a target post', async () => {
  let captured: RequestInit | undefined;
  await withFetch(async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ asset: { id: 'a'.repeat(32) } }), { status: 201 });
  }, async () => {
    const file = new Blob(['image bytes'], { type: 'image/png' }) as File;
    const result = await api.uploadImage(file);
    assert.equal(result.asset.id, 'a'.repeat(32));
  });
  assert.equal(captured?.method, 'POST');
  assert.ok(captured?.body instanceof FormData);
  assert.equal((captured?.body as FormData).get('postId'), null);
  assert.deepEqual(captured?.headers, {});
});

test('successful composer workflow uses stable identities and returns both attachments', async () => {
  const assetId = 'b'.repeat(32);
  const seen: any[] = [];
  const result = await submitComposerPost('hello', {
    imageFile: {} as File,
    youtubeUrl: 'https://youtu.be/abcdefghijk',
  }, 'submission-key-1234', {
    createPost: async (content, key) => {
      seen.push(['post', content, key]);
      return { post: { id: 99 } };
    },
    uploadImage: async () => ({ asset: { id: assetId } }),
    attachImage: async (id, postId) => { seen.push(['image', id, postId]); },
    attachYouTube: async (_url, postId, key) => { seen.push(['video', postId, key]); },
  });
  assert.equal(result.postId, 99);
  assert.deepEqual(result.attached, ['image', 'video']);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(seen[0], ['post', 'hello', 'submission-key-1234']);
  assert.deepEqual(seen[1], ['image', assetId, 99]);
  assert.equal(seen[2][0], 'video');
  assert.equal(seen[2][1], 99);
  assert.match(seen[2][2], /^[A-Za-z0-9_-]{16,100}$/);
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

test('post creation failure preserves the complete composer draft and submission key', async () => {
  const imageFile = {} as File;
  const draft = { imageFile, youtubeUrl: 'https://youtu.be/abcdefghijk' };
  let uploadCalls = 0;
  await assert.rejects(submitComposerPost('draft text', draft, 'stable-submission-key', {
    createPost: async (_content, key) => {
      assert.equal(key, 'stable-submission-key');
      throw new Error('create rejected');
    },
    uploadImage: async () => { uploadCalls += 1; return { asset: { id: 'a'.repeat(32) } }; },
    attachImage: async () => { uploadCalls += 1; },
    attachYouTube: async () => { uploadCalls += 1; },
  }), /create rejected/);
  assert.equal(uploadCalls, 0);
  assert.equal(draft.imageFile, imageFile);
  assert.equal(draft.youtubeUrl, 'https://youtu.be/abcdefghijk');
});

test('attachment retry reuses the known asset and keys without creating another post or upload', async () => {
  const imageFile = {} as File;
  const assetId = 'c'.repeat(32);
  let createCalls = 0;
  let uploadCalls = 0;
  let imageAttachCalls = 0;
  let videoCalls = 0;
  let committedImage = false;
  let committedVideo = false;
  let firstVideoKey = '';
  const dependencies = {
    createPost: async () => { createCalls += 1; return { post: { id: 321 } }; },
    uploadImage: async () => { uploadCalls += 1; return { asset: { id: assetId } }; },
    attachImage: async (id: string, postId: number) => {
      imageAttachCalls += 1;
      assert.equal(id, assetId); assert.equal(postId, 321);
      if (!committedImage) { committedImage = true; throw new Error('response lost after image commit'); }
    },
    attachYouTube: async (_url: string, postId: number, key: string) => {
      videoCalls += 1; assert.equal(postId, 321);
      if (!firstVideoKey) firstVideoKey = key;
      assert.equal(key, firstVideoKey);
      if (!committedVideo) { committedVideo = true; throw new Error('response lost after video commit'); }
    },
  };
  const first = await submitComposerPost('hello', {
    imageFile,
    youtubeUrl: 'https://youtu.be/abcdefghijk',
  }, 'submission-key-1234', dependencies);
  assert.deepEqual(first.failures.map(f => f.kind), ['image', 'video']);
  assert.equal(first.imageAssetId, assetId);
  assert.equal(first.videoAttachmentKey, firstVideoKey);

  const retry = await attachComposerMedia(321, {
    imageFile,
    youtubeUrl: 'https://youtu.be/abcdefghijk',
    imageAssetId: first.imageAssetId,
    videoAttachmentKey: first.videoAttachmentKey,
  }, dependencies);
  assert.equal(createCalls, 1);
  assert.equal(uploadCalls, 1);
  assert.equal(imageAttachCalls, 2);
  assert.equal(videoCalls, 2);
  assert.deepEqual(retry.attached, ['image', 'video']);
  assert.deepEqual(retry.failures, []);
});

test('submission lock rejects same-tick duplicate submissions and releases for retry', () => {
  const lock = new SubmissionLock();
  assert.equal(lock.tryAcquire(), true);
  assert.equal(lock.tryAcquire(), false);
  lock.release();
  assert.equal(lock.tryAcquire(), true);
});
