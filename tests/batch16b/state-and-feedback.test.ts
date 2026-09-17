import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import React from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiError } from '../../src/api/client.js';
import GamesPage from '../../src/pages/GamesPage.js';
import SettingsPage from '../../src/pages/SettingsPage.js';
import LoginPage from '../../src/pages/LoginPage.js';
import { RouteRequestGate } from '../../src/routeLoadState.js';
import { normalizeMediaCapabilities } from '../../src/hooks/useMediaCapabilities.js';
import { sessionFailureOutcome, sessionUserFromResponse } from '../../src/sessionState.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function textOf(root: ReactTestInstance): string {
  return root.findAll(() => true).flatMap(node => node.children.filter(child => typeof child === 'string')).join(' ');
}

function button(root: ReactTestInstance, label: string): ReactTestInstance {
  const found = root.findAllByType('button').find(node => node.children.join('') === label);
  assert.ok(found, `button ${label} not found`);
  return found;
}

test('initial loading, failure, retry, successful empty, and stale refresh are distinct', async () => {
  const original = api.get;
  const first = deferred<any>();
  api.get = async () => first.promise;
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(React.createElement(MemoryRouter, {}, React.createElement(GamesPage))); });
    assert.match(textOf(view.root), /Loading games/);
    assert.doesNotMatch(textOf(view.root), /No games are available/);
    await act(async () => first.reject(new Error('offline')));
    assert.match(textOf(view.root), /Could not load games/);
    assert.doesNotMatch(textOf(view.root), /No games are available/);

    api.get = async () => ({ games: [] });
    await act(async () => button(view.root, 'Retry').props.onClick());
    assert.doesNotMatch(textOf(view.root), /Could not load games/);
    assert.match(textOf(view.root), /No games are available/);

    api.get = async () => ({ games: [{ id: 1, slug: 'chess', name: 'Chess' }] });
    await act(async () => button(view.root, 'Refresh games').props.onClick());
    assert.match(textOf(view.root), /Chess/);
    api.get = async () => { throw new Error('offline'); };
    await act(async () => button(view.root, 'Refresh games').props.onClick());
    assert.match(textOf(view.root), /Previously loaded results may be stale/);
    assert.match(textOf(view.root), /Chess/);
  } finally {
    api.get = original;
    if (view) await act(async () => view.unmount());
  }
});

test('out-of-order request generations cannot populate the current view', () => {
  const gate = new RouteRequestGate();
  const old = gate.begin();
  const current = gate.begin();
  assert.equal(old(), false);
  assert.equal(current(), true);
  gate.invalidate();
  assert.equal(current(), false);
});

test('/me transport and 5xx failures retry while authentication rejection becomes anonymous', () => {
  assert.equal(sessionFailureOutcome(new ApiError('offline', { kind: 'network' })), 'retry');
  assert.equal(sessionFailureOutcome(new ApiError('down', { kind: 'http', status: 503 })), 'retry');
  assert.equal(sessionFailureOutcome(new ApiError('expired', { kind: 'http', status: 401 })), 'anonymous');
  assert.equal(sessionFailureOutcome(new ApiError('rejected', { kind: 'http', status: 403 })), 'anonymous');
  assert.equal(sessionFailureOutcome(new ApiError('malformed', { kind: 'invalid-response', status: 401 })), 'retry');
});

test('a successful malformed /me response remains a retryable session-check failure', () => {
  let failure: unknown;
  try {
    sessionUserFromResponse({});
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof ApiError);
  assert.equal(failure.kind, 'invalid-response');
  assert.equal(sessionFailureOutcome(failure), 'retry');
});

test('privacy writes remain server-confirmed, reject rapid races, and reconcile success', async () => {
  const originals = { get: api.get, updateProfile: api.updateProfile };
  api.get = async (url: string) => url.includes('blocked') ? { blocked: [] } : { muted: [] };
  const pending = deferred<any>();
  let writes = 0;
  api.updateProfile = async () => { writes += 1; return pending.promise; };
  const user = { id: 1, username: 'member', display_name: 'Member', role: 'user', is_verified: 1,
    dm_privacy: 'friends_of_friends', world_home_injection: 'world_home_few', game_discovery_enabled: 0 };
  let confirmed = user;
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(React.createElement(SettingsPage, { user, onUserChange: (next: any) => { confirmed = next; } })); });
    const noOne = button(view.root, 'No one');
    const everyone = button(view.root, 'Everyone');
    await act(async () => { void noOne.props.onClick(); void everyone.props.onClick(); });
    assert.equal(writes, 1);
    assert.equal(noOne.props.className.includes('btn-primary'), false);
    assert.match(textOf(view.root), /Saving privacy preference/);
    await act(async () => pending.reject(new Error('offline')));
    assert.match(textOf(view.root), /previous server-confirmed setting remains active/i);
    assert.equal(button(view.root, 'Friends of friends').props.className.includes('btn-primary'), true);

    const success = { ...user, dm_privacy: 'noone' };
    api.updateProfile = async () => ({ user: {}, authUser: success as any });
    await act(async () => button(view.root, 'No one').props.onClick());
    assert.equal(confirmed.dm_privacy, 'noone');
    assert.equal(button(view.root, 'No one').props.className.includes('btn-primary'), true);
  } finally {
    Object.assign(api, originals);
    if (view) await act(async () => view.unmount());
  }
});

test('stale privacy responses cannot update the global user after unmount or account replacement', async () => {
  const originals = { get: api.get, updateProfile: api.updateProfile };
  api.get = async (url: string) => url.includes('blocked') ? { blocked: [] } : { muted: [] };
  const firstUser = { id: 1, username: 'first', display_name: 'First', role: 'user', is_verified: 1,
    dm_privacy: 'friends_of_friends', world_home_injection: 'world_home_few', game_discovery_enabled: 0 };
  const secondUser = { ...firstUser, id: 2, username: 'second', display_name: 'Second' };
  let globalUpdates = 0;
  let view!: ReactTestRenderer;
  try {
    const afterUnmount = deferred<any>();
    api.updateProfile = async () => afterUnmount.promise;
    await act(async () => {
      view = create(React.createElement(SettingsPage, { user: firstUser, onUserChange: () => { globalUpdates += 1; } }));
    });
    await act(async () => { void button(view.root, 'No one').props.onClick(); });
    await act(async () => view.unmount());
    await act(async () => afterUnmount.resolve({ user: {}, authUser: { ...firstUser, dm_privacy: 'noone' } }));
    assert.equal(globalUpdates, 0);

    const afterAccountChange = deferred<any>();
    api.updateProfile = async () => afterAccountChange.promise;
    await act(async () => {
      view = create(React.createElement(SettingsPage, { user: firstUser, onUserChange: () => { globalUpdates += 1; } }));
    });
    await act(async () => { void button(view.root, 'No one').props.onClick(); });
    await act(async () => {
      view.update(React.createElement(SettingsPage, { user: secondUser, onUserChange: () => { globalUpdates += 1; } }));
    });
    await act(async () => afterAccountChange.resolve({ user: {}, authUser: { ...firstUser, dm_privacy: 'noone' } }));
    assert.equal(globalUpdates, 0);
  } finally {
    Object.assign(api, originals);
    if (view) await act(async () => view.unmount());
  }
});

test('forgot-password network and rate-limit failures are not presented as completed requests', async () => {
  const originals = { forgotPassword: api.forgotPassword };
  let view!: ReactTestRenderer;
  try {
    api.forgotPassword = async () => { throw new ApiError('limited', { kind: 'http', status: 429 }); };
    await act(async () => { view = create(React.createElement(MemoryRouter, {}, React.createElement(LoginPage, { onLogin() {} }))); });
    await act(async () => button(view.root, 'Forgot your password?').props.onClick());
    const input = view.root.findByProps({ placeholder: 'Email or username' });
    await act(async () => input.props.onChange({ target: { value: 'someone@example.test' } }));
    const form = input.parent;
    await act(async () => form!.props.onSubmit({ preventDefault() {} }));
    assert.match(textOf(view.root), /Too many password reset requests/);
    assert.doesNotMatch(textOf(view.root), /has been sent/);

    await act(async () => view.unmount());
    api.forgotPassword = async () => { throw new ApiError('offline', { kind: 'network' }); };
    await act(async () => { view = create(React.createElement(MemoryRouter, {}, React.createElement(LoginPage, { onLogin() {} }))); });
    await act(async () => button(view.root, 'Forgot your password?').props.onClick());
    const second = view.root.findByProps({ placeholder: 'Email or username' });
    await act(async () => second.props.onChange({ target: { value: 'someone' } }));
    await act(async () => second.parent!.props.onSubmit({ preventDefault() {} }));
    assert.match(textOf(view.root), /could not be submitted/i);
  } finally {
    api.forgotPassword = originals.forgotPassword;
    if (view) await act(async () => view.unmount());
  }
});

test('verification, resend, and OAuth copy does not guarantee delivery or expose operator configuration', () => {
  const login = fs.readFileSync(path.join(ROOT, 'src/pages/LoginPage.tsx'), 'utf8');
  const register = fs.readFileSync(path.join(ROOT, 'src/pages/RegisterPage.tsx'), 'utf8');
  const auth = fs.readFileSync(path.join(ROOT, 'server/routes/auth.ts'), 'utf8');
  const combined = `${login}\n${register}`;
  assert.doesNotMatch(combined, /Verification email sent|Add GOOGLE_CLIENT_ID|Add STEAM_RETURN_URL/);
  assert.match(combined, /If email delivery is available/);
  assert.match(auth, /If an eligible account matches and email delivery is available/);
});

test('capability parsing fails closed and direct video remains unavailable', () => {
  assert.equal(normalizeMediaCapabilities({}), null);
  const parsed = normalizeMediaCapabilities({
    imageUploads: { enabled: false, reason: 'off' }, avatarUploads: { enabled: false },
    externalVideoEmbeds: { enabled: false }, directVideoUploads: { enabled: true },
  });
  assert.equal(parsed?.imageUploads.enabled, false);
  assert.equal(parsed?.avatarUploads.enabled, false);
  assert.equal(parsed?.externalVideoEmbeds.enabled, false);
  assert.equal(parsed?.directVideoUploads.enabled, false);
});

test('limited and failed states do not reveal hidden identities, counts, or object existence', () => {
  const files = ['GroupsPage.tsx', 'DiscoverPage.tsx', 'FriendsPage.tsx', 'SettingsPage.tsx', 'NotificationsPage.tsx', 'WorldPage.tsx'];
  const source = files.map(file => fs.readFileSync(path.join(ROOT, 'src/pages', file), 'utf8')).join('\n');
  assert.doesNotMatch(source, /error.*blocked\.length|error.*followers\.length|error.*member_count/i);
  assert.match(source, /Could not load blocked and muted lists/);
  assert.match(source, /Source preferences are temporarily unavailable/);
});
