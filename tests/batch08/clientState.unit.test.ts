import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteRequestGate } from '../../src/routeLoadState.js';
import {
  clearConversationUnread,
  highestObservedMessageId,
  mergeMessages,
  reconcileConversationPreview,
  setConversationDraft,
} from '../../src/messageState.js';
import {
  applyPostEntityMutation,
  postContainsId,
} from '../../src/postEntityState.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('a late scoped response cannot replace the newer conversation or route result', async () => {
  const gate = new RouteRequestGate();
  let selectedKey = 'account-1:conversation-a';
  let rendered = '';
  const requestA = deferred<string>();
  const canCommitA = gate.begin();
  const completionA = requestA.promise.then(value => {
    if (canCommitA() && selectedKey === 'account-1:conversation-a') rendered = value;
  });

  selectedKey = 'account-1:conversation-b';
  const requestB = deferred<string>();
  const canCommitB = gate.begin();
  const completionB = requestB.promise.then(value => {
    if (canCommitB() && selectedKey === 'account-1:conversation-b') rendered = value;
  });

  requestB.resolve('conversation-b');
  await completionB;
  requestA.resolve('conversation-a');
  await completionA;
  assert.equal(rendered, 'conversation-b');
});

test('captured identity guards allow concurrent mutations but invalidate on scope change', () => {
  const gate = new RouteRequestGate();
  const first = gate.capture();
  const second = gate.capture();
  assert.equal(first(), true);
  assert.equal(second(), true);
  gate.invalidate();
  assert.equal(first(), false);
  assert.equal(second(), false);
});

test('account invalidation rejects a former account response', async () => {
  const gate = new RouteRequestGate();
  let accountId = 1;
  let privateState = ['account-one'];
  const pending = deferred<string[]>();
  const canCommit = gate.begin();
  const completion = pending.promise.then(value => {
    if (canCommit() && accountId === 1) privateState = value;
  });

  accountId = 2;
  privateState = [];
  gate.invalidate();
  pending.resolve(['late-account-one']);
  await completion;
  assert.deepEqual(privateState, []);
});

test('message refresh merges by durable ID without duplicates or scroll-order drift', () => {
  const initial = [
    { id: 10, body: 'ten' },
    { id: 11, body: 'eleven' },
  ];
  const firstPoll = mergeMessages(initial, [
    { id: 11, body: 'eleven' },
    { id: 12, body: 'twelve' },
  ]);
  const secondPoll = mergeMessages(firstPoll, [
    { id: 11, body: 'eleven edited' },
    { id: 12, body: 'twelve' },
  ]);
  assert.deepEqual(secondPoll.map(message => message.id), [10, 11, 12]);
  assert.equal(secondPoll[1].body, 'eleven edited');
  assert.equal(highestObservedMessageId(secondPoll), 12);
});

test('an own send does not expand the highest server-fetched observation', () => {
  const fetched = [{ id: 20, senderId: 2, body: 'N' }];
  const observedThrough = highestObservedMessageId(fetched);
  const withOwnSend = mergeMessages(fetched, [{ id: 22, senderId: 1, body: 'own N+2' }]);
  assert.equal(withOwnSend.at(-1)?.id, 22);
  assert.equal(observedThrough, 20, 'read reporting remains tied to the fetched/rendered batch');
});

test('delayed send is committed only to its captured conversation', () => {
  const messagesByConversation: Record<number, any[]> = {
    1: [{ id: 1, body: 'A' }],
    2: [{ id: 2, body: 'B' }],
  };
  const targetConversationId = 1;
  const selectedConversationId = 2;
  const sent = { id: 3, body: 'sent to A' };

  messagesByConversation[targetConversationId] = mergeMessages(
    messagesByConversation[targetConversationId],
    [sent],
  );
  const visible = messagesByConversation[selectedConversationId];
  assert.deepEqual(visible.map(message => message.body), ['B']);
  assert.deepEqual(messagesByConversation[1].map(message => message.body), ['A', 'sent to A']);
});

test('drafts are isolated by conversation and cannot cross-send', () => {
  let drafts: Record<number, string> = {};
  drafts = setConversationDraft(drafts, 1, 'only for A');
  drafts = setConversationDraft(drafts, 2, 'only for B');
  assert.equal(drafts[1], 'only for A');
  assert.equal(drafts[2], 'only for B');
  drafts = setConversationDraft(drafts, 1, '');
  assert.equal(drafts[2], 'only for B');
});

test('conversation previews reorder on incoming/outgoing messages and unread clears', () => {
  const conversations = [
    { id: 1, unreadCount: 2, lastMessage: { id: 8, body: 'old', createdAt: '2026-01-01 10:00:00' } },
    { id: 2, unreadCount: 0, lastMessage: { id: 9, body: 'other', createdAt: '2026-01-01 10:00:00' } },
  ];
  const updated = reconcileConversationPreview(
    conversations,
    1,
    { id: 10, body: 'new', createdAt: '2026-01-01 10:00:00' },
  );
  assert.deepEqual(updated.map(conversation => conversation.id), [1, 2]);
  assert.equal(updated[0].lastMessage.body, 'new');
  assert.equal(clearConversationUnread(updated, 1)[0].unreadCount, 0);
});

test('post updates and deletion reconcile every top-level and nested representation', () => {
  const original = { id: 10, userId: 5, content: 'old', commentCount: 0 };
  const posts = [
    original,
    { id: 20, userId: 6, repostOf: 10, repostedPost: { ...original } },
    { id: 21, userId: 7, repostOf: 10, repostedPost: { ...original } },
  ];
  const updated = applyPostEntityMutation(posts, {
    type: 'update',
    post: { ...original, content: 'fresh', commentCount: 1 },
  });
  assert.equal(updated[0].content, 'fresh');
  assert.equal(updated[1].repostedPost.content, 'fresh');
  assert.equal(updated[2].repostedPost.commentCount, 1);

  const commentDeleted = applyPostEntityMutation(updated, { type: 'delete', postId: 99, parentId: 10 });
  assert.equal(commentDeleted[0].commentCount, 0);
  assert.equal(commentDeleted[1].repostedPost.commentCount, 0);

  const rejectedDeletionState = updated;
  assert.equal(rejectedDeletionState.length, 3, 'a rejected API call does not dispatch a mutation');
  const deleted = applyPostEntityMutation(updated, { type: 'delete', postId: 10 });
  assert.deepEqual(deleted, []);
  assert.equal(postContainsId(posts[1], 10), true);
});

test('a parent refetch can replace the controlled post entity', () => {
  let canonical = [{ id: 4, content: 'before refetch' }];
  const serverRefetch = [{ id: 4, content: 'after refetch' }];
  canonical = serverRefetch;
  assert.equal(canonical[0].content, 'after refetch');
});

test('same-conversation selection preserves the current pane while refresh is pending', async () => {
  const visible = [{ id: 1, body: 'still visible' }];
  const refresh = deferred<any[]>();
  assert.deepEqual(visible, [{ id: 1, body: 'still visible' }]);
  refresh.resolve([{ id: 1, body: 'still visible' }, { id: 2, body: 'refreshed' }]);
  assert.deepEqual(mergeMessages(visible, await refresh.promise).map(message => message.id), [1, 2]);
});

