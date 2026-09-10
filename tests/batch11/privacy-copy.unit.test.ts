import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import PostCard from '../../src/components/PostCard';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

function renderPost(post: any): string {
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) originalError(...args);
  };
  try {
    return renderToStaticMarkup(React.createElement(
      MemoryRouter,
      {},
      React.createElement(PostCard, { post, currentUser: null, onMutation: () => {} }),
    ));
  } finally {
    console.error = originalError;
  }
}

function basePost(overrides: Record<string, unknown>) {
  return {
    id: 1,
    userId: 1,
    username: 'author',
    displayName: 'Author',
    content: 'Post',
    reactions: {},
    commentCount: 0,
    repostCount: 0,
    createdAt: '2026-01-01 00:00:00',
    ...overrides,
  };
}

test('PostCard renders named and neutral group origins from the authorized DTO', () => {
  const named = renderPost(basePost({ isGroupPost: true, group: { id: 9, name: 'Public Group' } }));
  assert.match(named, /Posted in/);
  assert.match(named, /Public Group/);
  assert.match(named, /href="\/groups\/9"/);

  const neutral = renderPost(basePost({ isGroupPost: true, group: null }));
  assert.match(neutral, /Posted in/);
  assert.match(neutral, /a group/);
  assert.doesNotMatch(neutral, /\/groups\//);
});

test('privacy and public-context copy is explicit and no private-group control is introduced', () => {
  const profile = fs.readFileSync(path.join(PROJECT_ROOT, 'src/pages/ProfilePage.tsx'), 'utf8');
  const group = fs.readFileSync(path.join(PROJECT_ROOT, 'src/pages/GroupPage.tsx'), 'utf8');
  const groups = fs.readFileSync(path.join(PROJECT_ROOT, 'src/pages/GroupsPage.tsx'), 'utf8');
  const lfg = fs.readFileSync(path.join(PROJECT_ROOT, 'src/pages/GameDetailPage.tsx'), 'utf8');
  const post = fs.readFileSync(path.join(PROJECT_ROOT, 'src/components/PostCard.tsx'), 'utf8');
  assert.match(profile, /people request to follow; you approve new followers/);
  assert.match(profile, /public groups, comments in accessible public threads, and active LFG listings remain public/);
  assert.match(group, /Public group — posts here may be visible/);
  assert.match(groups, /Private groups are not available/);
  assert.match(lfg, /Active LFG listings are public discovery content/);
  assert.match(post, /comment is visible to anyone who can view this thread/);
  assert.doesNotMatch(`${group}\n${groups}`, /private-group-selector|visibility.*private.*group/i);
});
