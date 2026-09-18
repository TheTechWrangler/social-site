import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import test from 'node:test';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../../src/api/client.js';
import HomeNavigationLink from '../../src/components/HomeNavigationLink.js';
import HomePage from '../../src/pages/HomePage.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const capabilities = {
  imageUploads: { enabled: true }, avatarUploads: { enabled: true },
  externalVideoEmbeds: { enabled: true }, directVideoUploads: { enabled: false },
};
const user = {
  id: 2, username: 'member', display_name: 'Member', is_verified: 1,
  feed_exposure: 'world', world_home_injection: 'world_home_few', show_videos_in_feed: 1,
};

function item(id: number, itemType: string) {
  return { id, type: 'world_item', itemType, sourceName: 'Chosen source', sourceCategory: 'general', title: `Item ${id}`, linkUrl: 'https://example.invalid/item', publishedAt: '2026-09-17T12:00:00Z' };
}

function response(items: any[], nextCursor: string | null = null) {
  return { posts: [], worldItems: items, items, level: 'world', itemType: 'all', showVideosInFeed: true,
    personalExternalFeedStatus: 'ready' as const, pagination: { hasMore: nextCursor !== null, nextCursor } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function button(view: ReactTestRenderer, label: string) {
  return view.root.findAllByType('button').find(node => node.children.join('') === label)!;
}

test('Load more is click-only and uses the returned cursor; viewport activity cannot auto-fetch', async () => {
  const originals = { feed: api.feed, get: api.get };
  const calls: any[] = [];
  api.get = async () => capabilities as any;
  api.feed = async (params: any) => {
    calls.push(params);
    return params?.cursor ? response([item(2, 'article')]) : response([item(1, 'video')], 'next-page');
  };
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(React.createElement(MemoryRouter, {}, React.createElement(HomePage, { user, onUserChange() {} }))); });
    assert.equal(calls.length, 1);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(fs.readFileSync(path.join(PROJECT_ROOT, 'src/pages/HomePage.tsx'), 'utf8'), /IntersectionObserver/);
    await act(async () => {
      const loadMore = button(view, 'Load more');
      await Promise.all([loadMore.props.onClick(), loadMore.props.onClick()]);
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].cursor, 'next-page');
    assert.equal(calls[1].offset, undefined);
  } finally {
    Object.assign(api, originals);
    if (view) await act(async () => view.unmount());
  }
});

test('temporary type controls reset to the first cursor page', async () => {
  const originals = { feed: api.feed, get: api.get };
  const calls: any[] = [];
  api.get = async () => capabilities as any;
  api.feed = async (params: any) => { calls.push(params); return response([]); };
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(React.createElement(MemoryRouter, {}, React.createElement(HomePage, { user, onUserChange() {} }))); });
    await act(async () => { button(view, 'Videos').props.onClick(); });
    assert.equal(calls.at(-1).itemType, 'video');
    assert.equal(calls.at(-1).cursor, undefined);
    assert.match(view.root.findAll(() => true).flatMap(node => node.children).join(' '), /subscribed video sources/);
  } finally {
    Object.assign(api, originals);
    if (view) await act(async () => view.unmount());
  }
});

test('a Home refresh token scrolls and refetches the first page without overlapping requests', async () => {
  const originals = { feed: api.feed, get: api.get };
  const pending = deferred<any>();
  const calls: any[] = [];
  let scrolls = 0;
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = { ...(originalWindow || {}), scrollTo: () => { scrolls += 1; } };
  api.get = async () => capabilities as any;
  api.feed = async (params: any) => {
    calls.push(params);
    return calls.length === 1 ? response([item(1, 'article')], 'old-cursor') : pending.promise;
  };
  let view!: ReactTestRenderer;
  const render = (refreshToken: number) => React.createElement(MemoryRouter, {}, React.createElement(HomePage, { user, onUserChange() {}, refreshToken }));
  try {
    await act(async () => { view = create(render(0)); });
    await act(async () => { view.update(render(1)); });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].cursor, undefined);
    await act(async () => { view.update(render(2)); });
    assert.equal(calls.length, 2);
    assert.equal(scrolls, 2);
    await act(async () => { pending.resolve(response([item(9, 'video')])); });
    assert.equal(calls.length, 2);
  } finally {
    Object.assign(api, originals);
    (globalThis as any).window = originalWindow;
    if (view) await act(async () => view.unmount());
  }
});

test('Home and RefugeCloud links refresh in place on Home and navigate normally elsewhere', async () => {
  let refreshes = 0;
  const homeTree = React.createElement(MemoryRouter, { initialEntries: ['/'] }, React.createElement('div', {},
    React.createElement(HomeNavigationLink, { onRefresh: () => { refreshes += 1; } }, 'RefugeCloud'),
    React.createElement(HomeNavigationLink, { onRefresh: () => { refreshes += 1; } }, 'Home')));
  let view!: ReactTestRenderer;
  await act(async () => { view = create(homeTree); });
  for (const anchor of view.root.findAllByType('a')) {
    let prevented = false;
    await act(async () => anchor.props.onClick({ preventDefault: () => { prevented = true; } }));
    assert.equal(prevented, true);
  }
  assert.equal(refreshes, 2);
  await act(async () => view.unmount());

  let prevented = false;
  await act(async () => { view = create(React.createElement(MemoryRouter, { initialEntries: ['/settings'] },
    React.createElement(HomeNavigationLink, { onRefresh: () => { refreshes += 1; } }, 'Home'))); });
  const anchor = view.root.findByType('a');
  await act(async () => anchor.props.onClick({ preventDefault: () => { prevented = true; } }));
  assert.equal(prevented, false);
  assert.equal(anchor.props.href, '/');
  assert.equal(refreshes, 2);
  await act(async () => view.unmount());
});
