import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, api } from '../../src/api/client.js';
import { applyPostEntityMutation } from '../../src/postEntityState.js';
import {
  beginPostEdit,
  failPostEditSave,
  startPostEditSave,
  updatePostEditDraft,
  reviewLatestPost,
} from '../../src/postEditState.js';

test('client sends expected version and canonical mutation updates top-level and nested copies', async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    captured = { url: String(input), init };
    return new Response(JSON.stringify({
      changed: true,
      post: { id: 7, content: 'edited', editVersion: 1, editedAt: '2026-09-11 12:00:00.000' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await api.editPost(7, 'edited', 0);
    assert.equal(captured?.url, '/api/posts/7');
    assert.equal(captured?.init?.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(captured?.init?.body)), { content: 'edited', expectedEditVersion: 0 });
    const representations = [
      { id: 7, content: 'old', editVersion: 0 },
      { id: 8, repostedPost: { id: 7, content: 'old', editVersion: 0 } },
    ];
    const reconciled = applyPostEntityMutation(representations, { type: 'update', post: result.post });
    assert.equal(reconciled[0].content, 'edited');
    assert.equal(reconciled[1].repostedPost.content, 'edited');
    assert.equal(reconciled[1].repostedPost.editVersion, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed and stale saves preserve the exact draft and captured starting version', async () => {
  let state = beginPostEdit({ id: 7, content: 'server v0', editVersion: 0 });
  state = updatePostEditDraft(state, 'my unsaved draft');
  state = startPostEditSave(state);
  state = failPostEditSave(state, 'This post changed in another window.');
  assert.equal(state.postId, 7);
  assert.equal(state.draft, 'my unsaved draft');
  assert.equal(state.expectedEditVersion, 0);
  assert.equal(state.saving, false);
  assert.match(state.error, /changed/);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'This post changed elsewhere.', code: 'STALE_POST_EDIT',
  }), { status: 409, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(api.editPost(7, state.draft, state.expectedEditVersion), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 409);
      assert.deepEqual(error.data, { error: 'This post changed elsewhere.', code: 'STALE_POST_EDIT' });
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(state.draft, 'my unsaved draft');
});

test('reviewing a newer post preserves the draft and explicitly rebases its expected version', () => {
  const draft = updatePostEditDraft(beginPostEdit({ id: 7, content: 'original', editVersion: 0 }), 'my draft');
  const conflict = failPostEditSave(draft, 'Changed elsewhere', true);
  const reviewed = reviewLatestPost(conflict, { id: 7, content: 'other tab edit', editVersion: 1 });
  assert.equal(reviewed.draft, 'my draft');
  assert.equal(reviewed.latestContent, 'other tab edit');
  assert.equal(reviewed.expectedEditVersion, 1);
  assert.equal(reviewed.conflict, false);
});

test('inline comments and nested copies reconcile edits and resist delayed older responses', () => {
  const comment = { id: 9, content: 'old comment', editVersion: 0, editedAt: null };
  const parent = { id: 7, content: 'parent', comments: [comment] };
  let posts = [parent, { id: 8, repostedPost: parent }, comment];
  const updated = { ...comment, content: 'edited comment', editVersion: 1, editedAt: '2026-09-11 12:00:00' };
  posts = applyPostEntityMutation(posts, { type: 'update', post: updated });
  posts = applyPostEntityMutation(posts, { type: 'comments-loaded', postId: 7, comments: [comment] });
  posts = applyPostEntityMutation(posts, { type: 'update', post: { ...comment, liked: true } });
  assert.equal(posts[0].comments[0].content, updated.content);
  assert.equal(posts[1].repostedPost.comments[0].content, updated.content);
  assert.equal(posts[2].content, updated.content);
  assert.equal(posts[2].editVersion, 1);
  assert.equal(posts[2].liked, true);
  const deleted = applyPostEntityMutation(posts, { type: 'delete', postId: 9, parentId: 7 });
  assert.equal(deleted[0].comments.length, 0);
  assert.equal(deleted[1].repostedPost.comments.length, 0);
});
