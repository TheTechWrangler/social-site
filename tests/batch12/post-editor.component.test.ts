import assert from 'node:assert/strict';
import test from 'node:test';
import React, { useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PostCard from '../../src/components/PostCard.js';
import PostDetailPage from '../../src/pages/PostDetailPage.js';
import { api, ApiError } from '../../src/api/client.js';
import { applyPostEntityMutation, type PostEntityMutation } from '../../src/postEntityState.js';

const author = { id: 3, is_verified: 1, role: 'user' };
const initial = {
  id: 7, userId: 3, username: 'author', displayName: 'Author', content: 'Original text',
  editVersion: 0, editedAt: null, canEdit: true, createdAt: '2026-09-11 10:00:00', commentCount: 0,
};

function Harness({ posts: supplied, user = author }: { posts: any[]; user?: any }) {
  const [posts, setPosts] = useState(supplied);
  const onMutation = (mutation: PostEntityMutation) => setPosts(current => applyPostEntityMutation(current, mutation));
  return React.createElement(MemoryRouter, {}, posts.map((post, index) =>
    React.createElement(PostCard, { key: index, post, currentUser: user, onMutation })));
}

function button(root: ReactTestInstance, text: string) {
  return root.findAllByType('button').find(node => node.children.join('') === text)!;
}
function submit(root: ReactTestInstance) {
  return root.findByProps({ className: 'post-edit-form' }).props.onSubmit({ preventDefault() {} });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function withCards(posts: any[], run: (view: ReactTestRenderer) => Promise<void>, user = author) {
  const originals = { editPost: api.editPost, getPost: api.getPost, getComments: api.getComments, getPostMedia: api.getPostMedia };
  api.getPostMedia = async () => ({ media: [{ id: 4, media_type: 'image', url: '/test/image.png' }] });
  api.getComments = async () => ({ comments: [] });
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(React.createElement(Harness, { posts, user })); });
    await run(view);
  } finally {
    if (view) await act(async () => view.unmount());
    Object.assign(api, originals);
  }
}

test('real PostCards prefill, cancel, prevent duplicate saves, preserve media and reconcile duplicate/nested edits', async () => {
  await withCards([initial, { ...initial }, { id: 10, userId: 4, repostOf: 7, repostedPost: initial }], async view => {
    const first = () => view.root.findAllByType(PostCard)[0];
    await act(async () => button(first(), 'Edit').props.onClick());
    assert.equal(first().findByType('textarea').props.value, initial.content);
    await act(async () => first().findByType('textarea').props.onChange({ target: { value: 'discarded' } }));
    await act(async () => button(first(), 'Cancel').props.onClick());
    assert.equal(first().findByProps({ className: 'post-content' }).children.join(''), initial.content);
    await act(async () => button(first(), 'Edit').props.onClick());
    assert.equal(first().findByType('textarea').props.value, initial.content);
    await act(async () => first().findByType('textarea').props.onChange({ target: { value: 'Updated text' } }));
    const pending = deferred<any>();
    let calls = 0;
    api.editPost = async (id, content, version) => {
      calls++;
      assert.deepEqual([id, content, version], [7, 'Updated text', 0]);
      return pending.promise;
    };
    await act(async () => { submit(first()); submit(first()); });
    assert.equal(calls, 1);
    assert.equal(button(first(), 'Saving…').props.disabled, true);
    assert.equal(button(first(), 'Cancel').props.disabled, true);
    assert.equal(first().findByProps({ className: 'post-media-img' }).props.src, '/test/image.png');
    const canonical = { ...initial, content: 'Updated text', editVersion: 1, editedAt: '2026-09-11 10:01:00' };
    await act(async () => pending.resolve({ post: canonical, changed: true }));
    assert.equal(first().findAllByType('textarea').length, 0);
    const copies = view.root.findAllByType(PostCard).filter(card => card.props.post.id === 7);
    assert.equal(copies.length, 3);
    for (const copy of copies) {
      assert.equal(copy.findByProps({ className: 'post-content' }).children.join(''), canonical.content);
      assert.match(copy.findByProps({ className: 'post-time' }).children.join(''), /Edited/);
    }
    assert.equal(first().findByProps({ className: 'post-media-img' }).props.src, '/test/image.png');
  });
});

test('failure and 409 retain the draft; loading latest text permits explicit reviewed retry', async () => {
  await withCards([initial], async view => {
    await act(async () => button(view.root, 'Edit').props.onClick());
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: 'My draft' } }));
    api.editPost = async () => { throw new ApiError('Offline', { kind: 'network' }); };
    await act(async () => { submit(view.root); });
    assert.equal(view.root.findByType('textarea').props.value, 'My draft');
    assert.equal(view.root.findByType(PostCard).props.post.content, initial.content);
    assert.match(view.root.findByProps({ role: 'alert' }).children.join(''), /Offline/);
    api.editPost = async () => { throw new ApiError('Changed elsewhere', { kind: 'http', status: 409, data: { code: 'STALE_POST_EDIT' } }); };
    await act(async () => { submit(view.root); });
    assert.equal(view.root.findByType('textarea').props.value, 'My draft');
    assert.equal(button(view.root, 'Save').props.disabled, true);
    api.getPost = async () => ({ post: { ...initial, content: 'Another tab', editVersion: 1, editedAt: '2026-09-11 10:01:00' } });
    await act(async () => button(view.root, 'Load latest text').props.onClick());
    assert.equal(view.root.findByType('textarea').props.value, 'My draft');
    assert.equal(view.root.findByType(PostCard).props.post.content, 'Another tab');
    assert.equal(button(view.root, 'Save').props.disabled, false);
    api.editPost = async (id, content, version) => {
      assert.deepEqual([id, content, version], [7, 'My draft', 1]);
      return { post: { ...initial, content, editVersion: 2, editedAt: '2026-09-11 10:02:00' }, changed: true };
    };
    await act(async () => { submit(view.root); });
    assert.equal(view.root.findByType(PostCard).props.post.content, 'My draft');
    assert.equal(view.root.findAllByType('textarea').length, 0);
  });
});

test('the actual detail page reconciles its separate comment cards and expanded inline copies', async () => {
  const reply = { ...initial, id: 9, parentId: 7, content: 'Comment' };
  const parent = { ...initial, comments: [reply], commentCount: 1 };
  await withCards([], async view => {
    api.getPost = async () => ({ post: parent });
    api.getComments = async () => ({ comments: [reply] });
    await act(async () => view.update(React.createElement(MemoryRouter, { initialEntries: ['/posts/7'] },
      React.createElement(Routes, {}, React.createElement(Route, {
        path: '/posts/:id', element: React.createElement(PostDetailPage, { user: author }),
      })))));
    const cards = () => view.root.findAllByType(PostCard);
    const expand = (card: ReactTestInstance) => card.findAllByType('button').find(node => node.children.join('').startsWith('💬'))!;
    assert.equal(cards().length, 2);
    await act(async () => { expand(cards()[0]).props.onClick(); });
    await act(async () => button(cards()[1], 'Edit').props.onClick());
    await act(async () => cards()[1].findByType('textarea').props.onChange({ target: { value: 'Edited comment' } }));
    api.editPost = async () => ({ post: { ...reply, content: 'Edited comment', editedAt: '2026-09-11 10:01:00', editVersion: 1 }, changed: true });
    await act(async () => { submit(cards()[1]); });
    const inline = cards()[0].findByProps({ className: 'comment' });
    assert.match(inline.findByType('p').children[0] as string, /Edited comment/);
    assert.equal(cards()[1].findByProps({ className: 'post-content' }).children.join(''), 'Edited comment');
  });
});

test('an edit response from a previous account scope cannot replace current state', async () => {
  await withCards([initial], async view => {
    await act(async () => button(view.root, 'Edit').props.onClick());
    await act(async () => view.root.findByType('textarea').props.onChange({ target: { value: 'Old account draft' } }));
    const pending = deferred<any>();
    api.editPost = async () => pending.promise;
    await act(async () => { submit(view.root); });
    await act(async () => view.update(React.createElement(Harness, { posts: [initial], user: { ...author, id: 99 } })));
    await act(async () => pending.resolve({ post: { ...initial, content: 'Old account draft', editVersion: 1 }, changed: true }));
    assert.equal(view.root.findByType(PostCard).props.post.content, initial.content);
    assert.equal(view.root.findAllByType('textarea').length, 0);
    assert.equal(button(view.root, 'Edit'), undefined);
  });
});

test('Edit is absent when the server marks a post ineligible or the viewer is not its owner', async () => {
  for (const post of [{ ...initial, canEdit: false }, { ...initial, userId: 8 }]) {
    await withCards([post], async view => assert.equal(button(view.root, 'Edit'), undefined));
  }
});
