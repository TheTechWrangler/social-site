import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';
import { boundedInteger } from '../../server/pagination.js';
import { reclaimManagedAssets } from '../../server/assetLifecycle.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');
const PRODUCTION_DB = path.join(PROJECT_ROOT, 'data', 'social.db');
const PRODUCTION_UPLOADS = path.join(PROJECT_ROOT, 'uploads');
const JWT_SECRET = 'isolated-privacy-jwt-secret-not-for-production';

let testRoot = '';
let databasePath = '';
let uploadsDir = '';
let baseUrl = '';
let server: ChildProcess | undefined;
let serverLog = '';
let db: Database.Database;
const ids: Record<string, number> = {};
let groupId = 0;
let privateOwnedGroupId = 0;
let gameId = 0;
let rssItemId = 0;
let blockedConversationId = 0;
let bannedConversationId = 0;
let limitedConversationId = 0;
let blockedMessageId = 0;
const postIds: Record<string, number> = {};
const lfgIds: Record<string, number> = {};
const worldCommentIds: Record<string, number> = {};
const notificationIds: Record<string, number> = {};

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        socket.close();
        reject(new Error('Could not allocate an isolated port.'));
        return;
      }
      socket.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server?.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Isolated server did not start. Log:\n${serverLog.slice(-8000)}`);
}

function cookie(username: string): string {
  const row = db.prepare(
    'SELECT id, username, role, is_verified FROM users WHERE username = ?',
  ).get(username) as any;
  const token = jwt.sign(
    {
      id: row.id,
      username: row.username,
      role: row.role,
      is_verified: row.is_verified,
    },
    JWT_SECRET,
    { expiresIn: '10m' },
  );
  return `refugecloud_auth=${token}`;
}

async function request(
  pathname: string,
  username?: string,
  options: RequestInit = {},
): Promise<{ response: Response; body: any }> {
  const headers = new Headers(options.headers);
  if (username) headers.set('cookie', cookie(username));
  if (options.body && !(options.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    redirect: 'manual',
    ...options,
    headers,
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

function names(rows: any[]): string[] {
  return rows.map(row => row.username).sort();
}

test('pagination rejects malformed inputs and clamps valid oversized values', () => {
  for (const input of [-1, '-1', 'NaN', 'Infinity', '1.5', 1.5, '', [], {}, '1e9', Number.MAX_VALUE]) {
    assert.equal(boundedInteger(input, 50, 1, 100), 50);
  }
  assert.equal(boundedInteger('999', 50, 1, 100), 100);
  assert.equal(boundedInteger('2', 50, 1, 100), 2);
});

before(async () => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-privacy-'));
  databasePath = path.join(testRoot, 'data', 'privacy.db');
  uploadsDir = path.join(testRoot, 'uploads');
  assert.notEqual(path.resolve(databasePath), path.resolve(PRODUCTION_DB));
  assert.notEqual(path.resolve(uploadsDir), path.resolve(PRODUCTION_UPLOADS));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o700 });

  const port = await freePort();
  assert.notEqual(port, 3003);
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(path.join(PROJECT_ROOT, 'node_modules/.bin/tsx'), ['server/index.ts'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DOTENV_CONFIG_PATH: '/dev/null',
      PORT: String(port),
      DATABASE_PATH: databasePath,
      UPLOADS_DIR: uploadsDir,
      JWT_SECRET,
      SESSION_SECRET: 'isolated-privacy-session-secret-not-for-production',
      APP_BASE_URL: baseUrl,
      WEB_BASE_URL: baseUrl,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      STEAM_API_KEY: '',
      STEAM_RETURN_URL: '',
      RESEND_API_KEY: '',
      RATE_LIMIT_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', chunk => { serverLog += String(chunk); });
  server.stderr?.on('data', chunk => { serverLog += String(chunk); });
  await waitForHealth();

  db = new Database(databasePath);
  const insertUser = db.prepare(`
    INSERT INTO users (
      username, display_name, email, password_hash, role, banned, is_verified,
      profile_visibility, bio, avatar_url, profile_data, game_discovery_enabled
    ) VALUES (?, ?, ?, 'test-only-hash', ?, ?, 1, ?, ?, ?, ?, ?)
  `);
  const users = [
    ['public', 'Public User', 'user', 0, 'public', 'public bio', '/uploads/public.jpg', '{"techInterests":"public tech"}', 1],
    ['private', 'Private User', 'user', 0, 'private', 'PRIVATE BIO SECRET', '/uploads/private.jpg', '{"techInterests":"PRIVATE INTEREST SECRET"}', 1],
    ['follower', 'Follower User', 'user', 0, 'public', 'follower bio', '', null, 1],
    ['stranger', 'Stranger User', 'user', 0, 'public', 'stranger bio', '', null, 1],
    ['blocker', 'Blocker User', 'user', 0, 'public', 'blocker bio', '', null, 1],
    ['banned', 'Banned User', 'user', 1, 'public', 'BANNED BIO SECRET', '/uploads/banned.jpg', '{"techInterests":"BANNED SECRET"}', 1],
    ['admin', 'Admin User', 'admin', 0, 'public', 'admin bio', '', null, 1],
  ] as const;
  for (const [username, displayName, role, banned, visibility, bio, avatar, profileData, discovery] of users) {
    const result = insertUser.run(
      username,
      displayName,
      `${username}@test.invalid`,
      role,
      banned,
      visibility,
      bio,
      avatar,
      profileData,
      discovery,
    );
    ids[username] = Number(result.lastInsertRowid);
  }

  db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)').run(ids.follower, ids.private);
  db.prepare(`
    INSERT INTO user_relationship_blocks (blocker_user_id, blocked_user_id, relationship_type)
    VALUES (?, ?, 'block')
  `).run(ids.blocker, ids.private);

  groupId = Number(db.prepare(
    'INSERT INTO groups_table (name, description, owner_id) VALUES (?, ?, ?)',
  ).run('Public Test Group', 'public group', ids.public).lastInsertRowid);
  privateOwnedGroupId = Number(db.prepare(
    'INSERT INTO groups_table (name, description, owner_id) VALUES (?, ?, ?)',
  ).run('Private Owner Group', 'public group owned by private user', ids.private).lastInsertRowid);
  const addMember = db.prepare(
    'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
  );
  addMember.run(groupId, ids.public, 'admin');
  addMember.run(groupId, ids.private, 'member');
  addMember.run(groupId, ids.banned, 'member');

  const addPost = db.prepare(
    'INSERT INTO posts (user_id, content, parent_id, group_id, hidden) VALUES (?, ?, ?, ?, 0)',
  );
  postIds.public = Number(addPost.run(ids.public, 'PUBLIC POST', null, null).lastInsertRowid);
  postIds.private = Number(addPost.run(ids.private, 'PRIVATE PROFILE POST SECRET', null, null).lastInsertRowid);
  postIds.banned = Number(addPost.run(ids.banned, 'BANNED POST SECRET', null, null).lastInsertRowid);
  postIds.groupPrivate = Number(addPost.run(ids.private, 'PRIVATE AUTHOR PUBLIC GROUP POST', null, groupId).lastInsertRowid);
  postIds.groupBanned = Number(addPost.run(ids.banned, 'BANNED GROUP POST SECRET', null, groupId).lastInsertRowid);
  postIds.privateComment = Number(addPost.run(ids.private, 'PRIVATE AUTHOR PUBLIC COMMENT', postIds.public, null).lastInsertRowid);
  postIds.bannedComment = Number(addPost.run(ids.banned, 'BANNED COMMENT SECRET', postIds.public, null).lastInsertRowid);
  postIds.repostPrivate = Number(addPost.run(ids.public, '', null, null).lastInsertRowid);
  db.prepare('UPDATE posts SET repost_of = ? WHERE id = ?').run(postIds.private, postIds.repostPrivate);

  const addReaction = db.prepare(
    "INSERT INTO likes (user_id, post_id, reaction_type) VALUES (?, ?, 'like')",
  );
  addReaction.run(ids.public, postIds.public);
  addReaction.run(ids.private, postIds.public);
  addReaction.run(ids.banned, postIds.public);

  db.prepare(
    "INSERT INTO post_media (post_id, media_type, url) VALUES (?, 'external_video', ?)",
  ).run(postIds.private, 'https://www.youtube.com/embed/abcdefghijk');
  db.prepare(
    "INSERT INTO post_media (post_id, media_type, url) VALUES (?, 'external_video', ?)",
  ).run(postIds.groupPrivate, 'https://www.youtube.com/embed/lmnopqrstuv');

  gameId = Number(db.prepare(
    "INSERT INTO games (name, slug, is_active) VALUES ('Privacy Game', 'privacy-game', 1)",
  ).run().lastInsertRowid);
  const addPreference = db.prepare(`
    INSERT INTO user_game_preferences (
      user_id, game_id, platform, notes, display_on_profile, looking_for_group
    ) VALUES (?, ?, 'PC', ?, 1, 1)
  `);
  addPreference.run(ids.private, gameId, 'PRIVATE GAME NOTES');
  addPreference.run(ids.banned, gameId, 'BANNED GAME NOTES');
  const addLfg = db.prepare(`
    INSERT INTO game_lfg_posts (user_id, game_id, title, body, is_active, expires_at)
    VALUES (?, ?, ?, ?, 1, datetime('now', '+6 hours'))
  `);
  lfgIds.private = Number(addLfg.run(
    ids.private, gameId, 'PRIVATE AUTHOR PUBLIC LFG', 'public lfg body',
  ).lastInsertRowid);
  lfgIds.banned = Number(addLfg.run(
    ids.banned, gameId, 'BANNED LFG SECRET', 'banned lfg body',
  ).lastInsertRowid);

  const sourceId = Number(db.prepare(
    "INSERT INTO rss_sources (name, url, is_active) VALUES ('Test Source', 'https://example.invalid/rss', 1)",
  ).run().lastInsertRowid);
  rssItemId = Number(db.prepare(`
    INSERT INTO rss_items (source_id, external_guid, title, link_url)
    VALUES (?, 'privacy-item', 'Privacy Item', 'https://example.invalid/item')
  `).run(sourceId).lastInsertRowid);
  const addWorldComment = db.prepare(
    'INSERT INTO rss_item_comments (rss_item_id, user_id, body) VALUES (?, ?, ?)',
  );
  worldCommentIds.private = Number(addWorldComment.run(
    rssItemId, ids.private, 'PRIVATE AUTHOR PUBLIC WORLD COMMENT',
  ).lastInsertRowid);
  worldCommentIds.banned = Number(addWorldComment.run(
    rssItemId, ids.banned, 'BANNED WORLD COMMENT SECRET',
  ).lastInsertRowid);
  worldCommentIds.replyToBanned = Number(db.prepare(`
    INSERT INTO rss_item_comments (rss_item_id, user_id, body, parent_id)
    VALUES (?, ?, ?, ?)
  `).run(
    rssItemId,
    ids.private,
    'PUBLIC REPLY TO HIDDEN WORLD COMMENT',
    worldCommentIds.banned,
  ).lastInsertRowid);

  const addNotification = db.prepare(`
    INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'comment', ?)
  `);
  notificationIds.public = Number(addNotification.run(
    ids.blocker, ids.public, postIds.public,
  ).lastInsertRowid);
  notificationIds.private = Number(addNotification.run(
    ids.blocker, ids.private, postIds.privateComment,
  ).lastInsertRowid);
  notificationIds.banned = Number(addNotification.run(
    ids.blocker, ids.banned, postIds.bannedComment,
  ).lastInsertRowid);

  const addConversation = db.prepare('INSERT INTO dm_conversations DEFAULT VALUES');
  const addConversationMember = db.prepare(
    'INSERT INTO dm_conversation_members (conversation_id, user_id) VALUES (?, ?)',
  );
  const addMessage = db.prepare(
    'INSERT INTO dm_messages (conversation_id, sender_id, body) VALUES (?, ?, ?)',
  );
  blockedConversationId = Number(addConversation.run().lastInsertRowid);
  addConversationMember.run(blockedConversationId, ids.blocker);
  addConversationMember.run(blockedConversationId, ids.private);
  blockedMessageId = Number(addMessage.run(
    blockedConversationId, ids.private, 'BLOCKED MESSAGE SECRET',
  ).lastInsertRowid);

  bannedConversationId = Number(addConversation.run().lastInsertRowid);
  addConversationMember.run(bannedConversationId, ids.blocker);
  addConversationMember.run(bannedConversationId, ids.banned);
  addMessage.run(bannedConversationId, ids.banned, 'BANNED MESSAGE SECRET');

  limitedConversationId = Number(addConversation.run().lastInsertRowid);
  addConversationMember.run(limitedConversationId, ids.stranger);
  addConversationMember.run(limitedConversationId, ids.private);
  addMessage.run(limitedConversationId, ids.private, 'PRIVATE DIRECT MESSAGE');
});

after(async () => {
  db?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => server!.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000)),
    ]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  if (testRoot.startsWith(path.join(os.tmpdir(), 'refugecloud-privacy-'))) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } else {
    throw new Error(`Refusing to clean unexpected test path: ${testRoot}`);
  }
});

test('profile policy covers anonymous, limited, follower, self, admin, block, and ban', async () => {
  const publicAnon = await request('/api/users/public');
  assert.equal(publicAnon.response.status, 200);
  assert.equal(publicAnon.body.user.bio, 'public bio');

  assert.equal((await request('/api/users/private')).response.status, 404);

  const limited = await request('/api/users/private', 'stranger');
  assert.equal(limited.response.status, 200);
  assert.deepEqual(
    Object.keys(limited.body.user).sort(),
    ['avatarUrl', 'displayName', 'id', 'isFollowing', 'isPrivate', 'limited', 'username'].sort(),
  );
  assert.equal(limited.body.user.limited, true);
  assert.equal(JSON.stringify(limited.body).includes('PRIVATE'), false);

  for (const viewer of ['follower', 'private', 'admin']) {
    const result = await request('/api/users/private', viewer);
    assert.equal(result.response.status, 200, viewer);
    assert.equal(result.body.user.bio, 'PRIVATE BIO SECRET', viewer);
    assert.equal(result.body.user.profileData.techInterests, 'PRIVATE INTEREST SECRET', viewer);
  }

  assert.equal((await request('/api/users/private', 'blocker')).response.status, 404);
  assert.equal((await request('/api/users/blocker', 'private')).response.status, 404);
  assert.equal((await request('/api/users/banned', 'admin')).response.status, 404);
});

test('profile updates return canonical saved profile and refreshed auth state', async () => {
  const original = db.prepare(`
    SELECT display_name, bio, avatar_url, profile_visibility, profile_data,
      game_discovery_enabled
    FROM users WHERE id = ?
  `).get(ids.public) as any;

  try {
    const longDisplayName = `  ${'N'.repeat(90)}  `;
    const longProject = `  ${'P'.repeat(310)}  `;
    const saved = await request('/api/users/profile', 'public', {
      method: 'PUT',
      body: JSON.stringify({
        displayName: longDisplayName,
        bio: '  canonical bio  ',
        profileVisibility: 'private',
        gameDiscoveryEnabled: false,
        profileData: {
          techInterests: '  TypeScript  ',
          platforms: '',
          currentProjects: longProject,
          websiteUrl: 'javascript:alert(1)',
        },
      }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.user.displayName, 'N'.repeat(80));
    assert.equal(saved.body.user.bio, 'canonical bio');
    assert.equal(saved.body.user.profileVisibility, 'private');
    assert.equal(saved.body.user.isPrivate, true);
    assert.deepEqual(saved.body.user.profileData, {
      techInterests: 'TypeScript',
      currentProjects: 'P'.repeat(300),
    });
    assert.equal(saved.body.authUser.display_name, 'N'.repeat(80));
    assert.equal(saved.body.authUser.profile_visibility, 'private');
    assert.equal(saved.body.authUser.game_discovery_enabled, 0);

    const refetched = await request('/api/users/public', 'public');
    assert.equal(refetched.response.status, 200);
    assert.deepEqual(refetched.body.user, saved.body.user);
    assert.equal((await request('/api/users/PUBLIC', 'public')).response.status, 200);
    assert.equal((await request('/api/users/PUBLIC/posts', 'public')).response.status, 200);

    const cleared = await request('/api/users/profile', 'public', {
      method: 'PUT',
      body: JSON.stringify({
        bio: null,
        profileVisibility: 'public',
        profileData: null,
        avatar_url: '',
      }),
    });
    assert.equal(cleared.response.status, 200);
    assert.equal(cleared.body.user.bio, '');
    assert.equal(cleared.body.user.avatarUrl, '');
    assert.equal(cleared.body.user.profileVisibility, 'public');
    assert.deepEqual(cleared.body.user.profileData, {});

    const clearedRefetch = await request('/api/users/public', 'public');
    assert.equal(clearedRefetch.body.user.bio, '');
    assert.equal(clearedRefetch.body.user.avatarUrl, '');
    assert.deepEqual(clearedRefetch.body.user.profileData, {});

    const emptyName = await request('/api/users/profile', 'public', {
      method: 'PUT',
      body: JSON.stringify({ displayName: '   ' }),
    });
    assert.equal(emptyName.response.status, 400);
    const invalidVisibility = await request('/api/users/profile', 'public', {
      method: 'PUT',
      body: JSON.stringify({ profileVisibility: 'secret' }),
    });
    assert.equal(invalidVisibility.response.status, 400);
  } finally {
    db.prepare(`
      UPDATE users SET display_name = ?, bio = ?, avatar_url = ?,
        profile_visibility = ?, profile_data = ?, game_discovery_enabled = ?
      WHERE id = ?
    `).run(
      original.display_name,
      original.bio,
      original.avatar_url,
      original.profile_visibility,
      original.profile_data,
      original.game_discovery_enabled,
      ids.public,
    );
  }
});

test('search and connection discovery never upgrade limited or hidden identities', async () => {
  const anonymous = await request('/api/users?q=');
  assert.equal(names(anonymous.body.users).includes('private'), false);
  assert.equal(names(anonymous.body.users).includes('banned'), false);

  const limited = await request('/api/users?q=private', 'stranger');
  assert.equal(limited.body.users.length, 1);
  assert.equal(limited.body.users[0].limited, true);
  assert.equal('bio' in limited.body.users[0], false);
  assert.equal(JSON.stringify(limited.body).includes('PRIVATE'), false);

  const follower = await request('/api/users?q=private', 'follower');
  assert.equal(follower.body.users[0].bio, 'PRIVATE BIO SECRET');

  const blocked = await request('/api/users?q=private', 'blocker');
  assert.deepEqual(blocked.body.users, []);
});

test('profile posts, feeds, comments, and media honor account versus publication scope', async () => {
  assert.equal((await request(`/api/posts/${postIds.private}`)).response.status, 404);
  assert.equal((await request(`/api/posts/${postIds.private}`, 'stranger')).response.status, 404);
  assert.equal((await request(`/api/posts/${postIds.private}`, 'follower')).response.status, 200);
  assert.equal((await request(`/api/posts/${postIds.private}`, 'private')).response.status, 200);
  assert.equal((await request(`/api/posts/${postIds.private}`, 'admin')).response.status, 200);
  assert.equal((await request(`/api/posts/${postIds.private}`, 'blocker')).response.status, 404);
  assert.equal((await request(`/api/posts/${postIds.banned}`, 'admin')).response.status, 404);

  assert.equal((await request('/api/users/private/posts', 'stranger')).response.status, 404);
  const followerPosts = await request('/api/users/private/posts', 'follower');
  assert.deepEqual(followerPosts.body.posts.map((post: any) => post.id), [postIds.private]);

  assert.equal((await request(`/api/posts/${postIds.groupPrivate}`)).response.status, 200);
  assert.equal((await request(`/api/posts/${postIds.groupPrivate}`, 'blocker')).response.status, 404);

  const hiddenRepost = await request(`/api/posts/${postIds.repostPrivate}`);
  assert.equal(hiddenRepost.response.status, 200);
  assert.equal(hiddenRepost.body.post.repostOf, null);
  assert.equal(hiddenRepost.body.post.repostedPost, null);
  assert.equal(JSON.stringify(hiddenRepost.body).includes('PRIVATE PROFILE POST SECRET'), false);

  const commentsAnon = await request(`/api/comments/${postIds.public}`);
  assert.deepEqual(commentsAnon.body.comments.map((comment: any) => comment.id), [postIds.privateComment]);
  const commentsBlocked = await request(`/api/comments/${postIds.public}`, 'blocker');
  assert.deepEqual(commentsBlocked.body.comments, []);

  const anonymousReactions = await request(`/api/likes/post/${postIds.public}`);
  assert.equal(anonymousReactions.body.counts.like, 1);
  const signedInReactions = await request(`/api/likes/post/${postIds.public}`, 'stranger');
  assert.equal(signedInReactions.body.counts.like, 2);
  const blockedReactions = await request(`/api/likes/post/${postIds.public}`, 'blocker');
  assert.equal(blockedReactions.body.counts.like, 1);

  const feedAnon = await request('/api/feed?level=everyone');
  const feedIds = feedAnon.body.posts.map((post: any) => post.id);
  assert.ok(feedIds.includes(postIds.public));
  assert.ok(feedIds.includes(postIds.groupPrivate));
  assert.equal(feedIds.includes(postIds.private), false);
  assert.equal(feedIds.includes(postIds.banned), false);
  assert.equal(feedIds.includes(postIds.groupBanned), false);

  const feedFollower = await request('/api/feed?level=everyone', 'follower');
  assert.ok(feedFollower.body.posts.some((post: any) => post.id === postIds.private));
  const feedBlocked = await request('/api/feed?level=everyone', 'blocker');
  assert.equal(feedBlocked.body.posts.some((post: any) => post.userId === ids.private), false);

  assert.equal((await request(`/api/uploads/post/${postIds.private}`, 'stranger')).response.status, 404);
  assert.equal((await request(`/api/uploads/post/${postIds.private}`, 'follower')).response.status, 200);
  assert.equal((await request(`/api/uploads/post/${postIds.groupPrivate}`)).response.status, 200);
});

test('public groups expose deliberate posts but not hidden member identities', async () => {
  const anonymous = await request(`/api/groups/${groupId}`);
  assert.equal(anonymous.response.status, 200);
  assert.equal(names(anonymous.body.members).includes('private'), false);
  assert.equal(names(anonymous.body.members).includes('banned'), false);
  assert.ok(anonymous.body.posts.some((post: any) => post.id === postIds.groupPrivate));
  assert.equal(anonymous.body.posts.some((post: any) => post.id === postIds.groupBanned), false);

  const signedIn = await request(`/api/groups/${groupId}`, 'stranger');
  const privateMember = signedIn.body.members.find((member: any) => member.username === 'private');
  assert.equal(privateMember.limited, true);
  assert.equal('role' in privateMember, false);

  const blocked = await request(`/api/groups/${groupId}`, 'blocker');
  assert.equal(names(blocked.body.members).includes('private'), false);
  assert.equal(blocked.body.posts.some((post: any) => post.userId === ids.private), false);

  const missingJoin = await request('/api/groups/999999/join', 'blocker', { method: 'POST' });
  const hiddenJoin = await request(`/api/groups/${privateOwnedGroupId}/join`, 'blocker', { method: 'POST' });
  assert.equal(hiddenJoin.response.status, 404);
  assert.deepEqual(hiddenJoin.body, missingJoin.body);

  const hiddenPost = await request('/api/posts', 'blocker', {
    method: 'POST',
    body: JSON.stringify({ content: 'must not publish', groupId: privateOwnedGroupId }),
  });
  assert.equal(hiddenPost.response.status, 404);
});

test('LFG is public context while game profile discovery remains profile-scoped', async () => {
  const anonymous = await request('/api/games/privacy-game');
  assert.deepEqual(anonymous.body.lfgPosts.map((post: any) => post.username), ['private']);
  assert.deepEqual(anonymous.body.players, []);

  const blocked = await request('/api/games/privacy-game', 'blocker');
  assert.deepEqual(blocked.body.lfgPosts, []);
  assert.deepEqual(blocked.body.players, []);

  const stranger = await request('/api/games/privacy-game', 'stranger');
  assert.equal(stranger.body.players.some((player: any) => player.user_id === ids.private), false);

  const follower = await request('/api/games/privacy-game', 'follower');
  assert.ok(follower.body.players.some((player: any) => player.user_id === ids.private));

  const standalone = await request('/api/games/privacy-game/lfg');
  assert.deepEqual(standalone.body.posts.map((post: any) => post.username), ['private']);
});

test('World Feed comments preserve public publication but enforce blocks and bans', async () => {
  const anonymous = await request(`/api/world-feed/${rssItemId}/comments`);
  assert.deepEqual(anonymous.body.comments.map((comment: any) => comment.username), ['private', 'private']);
  const reply = anonymous.body.comments.find((comment: any) => comment.id === worldCommentIds.replyToBanned);
  assert.equal(reply.parentId, null);

  const blocked = await request(`/api/world-feed/${rssItemId}/comments`, 'blocker');
  assert.deepEqual(blocked.body.comments, []);
});

test('reports preserve indistinguishable hidden-target responses under centralized policy', async () => {
  const payload = (targetType: string, targetId: number) => JSON.stringify({
    targetType,
    targetId,
    reason: 'Spam',
    details: 'Privacy matrix integration test.',
  });
  const missing = await request('/api/reports', 'stranger', {
    method: 'POST',
    body: payload('post', 999999),
  });
  const privatePost = await request('/api/reports', 'stranger', {
    method: 'POST',
    body: payload('post', postIds.private),
  });
  assert.equal(privatePost.response.status, 404);
  assert.deepEqual(privatePost.body, missing.body);

  const publicGroupPost = await request('/api/reports', 'stranger', {
    method: 'POST',
    body: payload('post', postIds.groupPrivate),
  });
  assert.equal(publicGroupPost.response.status, 201);

  const blockedGroupPost = await request('/api/reports', 'blocker', {
    method: 'POST',
    body: payload('post', postIds.groupPrivate),
  });
  assert.equal(blockedGroupPost.response.status, 404);
  assert.deepEqual(blockedGroupPost.body, missing.body);
});

test('notifications suppress blocked and banned actors in rows and unread counts', async () => {
  const result = await request('/api/notifications', 'blocker');
  assert.deepEqual(result.body.notifications.map((row: any) => row.actor_username), ['public']);

  const unread = await request('/api/notifications/unread-count', 'blocker');
  assert.equal(unread.body.count, 1);

  const missing = await request('/api/notifications/999999/read', 'blocker', { method: 'PATCH' });
  const hidden = await request(`/api/notifications/${notificationIds.private}/read`, 'blocker', { method: 'PATCH' });
  assert.equal(hidden.response.status, 404);
  assert.deepEqual(hidden.body, missing.body);
});

test('historical conversations do not bypass block or ban identity suppression', async () => {
  const conversations = await request('/api/messages', 'blocker');
  assert.deepEqual(conversations.body.conversations, []);
  assert.equal(JSON.stringify(conversations.body).includes('SECRET'), false);

  assert.equal(
    (await request(`/api/messages/${blockedConversationId}`, 'blocker')).response.status,
    404,
  );
  assert.equal(
    (await request(`/api/messages/${bannedConversationId}`, 'blocker')).response.status,
    404,
  );

  const unread = await request('/api/messages/unread-count', 'blocker');
  assert.equal(unread.body.count, 0);

  const messagePayload = { method: 'POST', body: JSON.stringify({ body: 'hidden probe' }) };
  assert.equal(
    (await request(`/api/messages/${blockedConversationId}`, 'blocker', messagePayload)).response.status,
    404,
  );
  assert.equal(
    (await request(`/api/messages/${blockedConversationId}/read`, 'blocker', { method: 'POST' })).response.status,
    404,
  );
  assert.equal(
    (await request(
      `/api/messages/${blockedConversationId}/messages/${blockedMessageId}`,
      'blocker',
      { method: 'DELETE' },
    )).response.status,
    404,
  );

  const missingTarget = await request('/api/messages', 'blocker', {
    method: 'POST',
    body: JSON.stringify({ userId: 999999 }),
  });
  const blockedTarget = await request('/api/messages', 'blocker', {
    method: 'POST',
    body: JSON.stringify({ userId: ids.private }),
  });
  assert.equal(blockedTarget.response.status, 404);
  assert.deepEqual(blockedTarget.body, missingTarget.body);
});

test('private non-follower conversations expose only the limited identity card', async () => {
  const conversations = await request('/api/messages', 'stranger');
  assert.equal(conversations.body.conversations.length, 1);
  assert.deepEqual(
    Object.keys(conversations.body.conversations[0].otherUser).sort(),
    ['avatarUrl', 'displayName', 'id', 'username'].sort(),
  );

  const conversation = await request(`/api/messages/${limitedConversationId}`, 'stranger');
  assert.equal(conversation.response.status, 200);
  assert.deepEqual(
    Object.keys(conversation.body.otherUser).sort(),
    ['avatarUrl', 'displayName', 'id', 'username'].sort(),
  );
  assert.equal(JSON.stringify(conversation.body.otherUser).includes('dmPrivacy'), false);
  assert.equal(JSON.stringify(conversation.body.otherUser).includes('isVerified'), false);
});

test('owner/admin mutations do not disclose unauthorized hidden object existence', async () => {
  const missingPost = await request('/api/posts/999999', 'stranger', { method: 'DELETE' });
  const privatePost = await request(`/api/posts/${postIds.private}`, 'stranger', { method: 'DELETE' });
  assert.equal(privatePost.response.status, 404);
  assert.deepEqual(privatePost.body, missingPost.body);

  const missingLfg = await request('/api/games/lfg/999999', 'blocker', { method: 'DELETE' });
  const blockedLfg = await request(`/api/games/lfg/${lfgIds.private}`, 'blocker', { method: 'DELETE' });
  assert.equal(blockedLfg.response.status, 404);
  assert.deepEqual(blockedLfg.body, missingLfg.body);

  const missingExtend = await request('/api/games/lfg/999999/extend', 'blocker', {
    method: 'POST',
    body: JSON.stringify({ durationHours: 6 }),
  });
  const blockedExtend = await request(`/api/games/lfg/${lfgIds.private}/extend`, 'blocker', {
    method: 'POST',
    body: JSON.stringify({ durationHours: 6 }),
  });
  assert.equal(blockedExtend.response.status, 404);
  assert.deepEqual(blockedExtend.body, missingExtend.body);

  const missingWorldComment = await request('/api/world-feed/comments/999999', 'stranger', { method: 'DELETE' });
  const bannedWorldComment = await request(
    `/api/world-feed/comments/${worldCommentIds.banned}`,
    'stranger',
    { method: 'DELETE' },
  );
  assert.equal(bannedWorldComment.response.status, 404);
  assert.deepEqual(bannedWorldComment.body, missingWorldComment.body);

  const externalVideoBody = (postId: number) => JSON.stringify({
    postId,
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    attachmentKey: 'privacy-target-test-key',
  });
  const missingUploadTarget = await request('/api/uploads/external-video', 'stranger', {
    method: 'POST',
    body: externalVideoBody(999999),
  });
  const privateUploadTarget = await request('/api/uploads/external-video', 'stranger', {
    method: 'POST',
    body: externalVideoBody(postIds.private),
  });
  assert.equal(privateUploadTarget.response.status, 404);
  assert.deepEqual(privateUploadTarget.body, missingUploadTarget.body);

  const missingGroupMember = await request('/api/groups/999999/members/999999', 'blocker', {
    method: 'DELETE',
  });
  const hiddenGroupOwner = await request(
    `/api/groups/${privateOwnedGroupId}/members/${ids.private}`,
    'blocker',
    { method: 'DELETE' },
  );
  assert.equal(hiddenGroupOwner.response.status, 404);
  assert.deepEqual(hiddenGroupOwner.body, missingGroupMember.body);
});

test('World Feed counts match visible comments in ranked and source-filtered feeds', async () => {
  const source = db.prepare('SELECT source_id FROM rss_items WHERE id = ?').get(rssItemId) as any;
  for (const viewer of [undefined, 'stranger', 'blocker', 'private', 'admin']) {
    const comments = await request(`/api/world-feed/${rssItemId}/comments`, viewer);
    for (const route of ['/api/world-feed', `/api/world-feed?sourceId=${source.source_id}`, '/api/feed?level=world']) {
      const result = await request(route, viewer);
      assert.equal(result.response.status, 200);
      const item = result.body.items.find((row: any) => row.id === rssItemId);
      assert.equal(item.comment_count, comments.body.comments.length, `${viewer}: ${route}`);
    }
  }
});

test('profile relationship counts exclude hidden identities in both directions', async () => {
  const follow = db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)');
  for (const name of ['private', 'banned', 'stranger']) {
    follow.run(ids.public, ids[name]);
    follow.run(ids[name], ids.public);
  }
  try {
    for (const [viewer, count] of [[undefined, 1], ['blocker', 1], ['stranger', 2]] as const) {
      const result = await request('/api/users/public', viewer);
      assert.equal(result.body.user.followerCount, count);
      assert.equal(result.body.user.followingCount, count);
    }
  } finally {
    db.prepare('DELETE FROM follows WHERE follower_id = ? OR following_id = ?').run(ids.public, ids.public);
  }
});

test('leave cannot distinguish a hidden group from a missing group for nonmembers', async () => {
  const missing = await request('/api/groups/999999/leave', 'blocker', { method: 'POST' });
  const hidden = await request(`/api/groups/${privateOwnedGroupId}/leave`, 'blocker', { method: 'POST' });
  assert.equal(hidden.response.status, missing.response.status);
  assert.deepEqual(hidden.body, missing.body);
  assert.equal(hidden.response.status, 200);
});

test('feed and message pagination cannot disable row limits', async () => {
  const inserted: number[] = [];
  for (let i = 0; i < 110; i++) {
    inserted.push(Number(db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(ids.public, 'PAGINATION').lastInsertRowid));
    db.prepare('INSERT INTO dm_messages (conversation_id, sender_id, body) VALUES (?, ?, ?)').run(limitedConversationId, ids.private, 'PAGINATION');
  }
  try {
    for (const value of ['-1', 'NaN', 'Infinity', '1.5', '99999999999999999999', '0']) {
      const feed = await request(`/api/feed?level=everyone&limit=${value}&offset=-1`);
      assert.equal(feed.response.status, 200);
      assert.ok(feed.body.posts.length <= 100);
      const messages = await request(`/api/messages/${limitedConversationId}?limit=${value}&before=NaN`, 'stranger');
      assert.equal(messages.response.status, 200);
      assert.ok(messages.body.messages.length <= 50);
      const world = await request(`/api/world-feed?limit=${value}&offset=-1`);
      assert.equal(world.response.status, 200);
      assert.ok(world.body.items.length <= 100);
    }
  } finally {
    for (const id of inserted) db.prepare('DELETE FROM posts WHERE id = ?').run(id);
    db.prepare("DELETE FROM dm_messages WHERE body = 'PAGINATION'").run();
  }
});

test('repost chains and cycles have bounded visible expansion', async () => {
  const chain: number[] = [];
  let previous = postIds.public;
  for (let i = 0; i < 12; i++) {
    previous = Number(db.prepare('INSERT INTO posts (user_id, content, repost_of) VALUES (?, ?, ?)').run(ids.public, '', previous).lastInsertRowid);
    chain.push(previous);
  }
  try {
    for (const cyclic of [false, true]) {
      if (cyclic) db.prepare('UPDATE posts SET repost_of = ? WHERE id = ?').run(previous, chain[0]);
      const result = await request(`/api/posts/${previous}`);
      assert.equal(result.response.status, 200);
      let current = result.body.post;
      let count = 1;
      while (current.repostedPost) { current = current.repostedPost; count++; }
      assert.ok(count <= 4);
      assert.equal(current.repostOf, null);
    }
  } finally {
    db.prepare('UPDATE posts SET repost_of = NULL WHERE id = ?').run(chain[0]);
    for (const id of chain.reverse()) db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  }
});

test('attached files prohibit browser caching and recheck changed visibility', async () => {
  const filename = 'privacy-cache-regression.png';
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'));
  const post = Number(db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(ids.private, 'CACHE TEST').lastInsertRowid);
  db.prepare("INSERT INTO post_media (post_id, media_type, url) VALUES (?, 'image', ?)").run(post, `/uploads/${filename}`);
  try {
    const allowed = await request(`/uploads/${filename}`, 'follower');
    assert.equal(allowed.response.status, 200);
    assert.match(allowed.response.headers.get('cache-control') || '', /no-store/);
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(ids.follower, ids.private);
    const denied = await request(`/uploads/${filename}`, 'follower');
    assert.equal(denied.response.status, 404);
    assert.equal((await request(`/uploads/${filename}`, 'blocker')).response.status, 404);
  } finally {
    db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').run(ids.follower, ids.private);
    db.prepare('DELETE FROM posts WHERE id = ?').run(post);
    fs.unlinkSync(path.join(uploadsDir, filename));
  }
});

test('local upload URLs cannot be adopted to broaden media access', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const filenames = {
    other: 'avatar-bypass-other.png',
    private: 'avatar-bypass-private.png',
    hidden: 'avatar-bypass-hidden.png',
    blocked: 'avatar-bypass-blocked.png',
    orphan: 'avatar-bypass-orphan.png',
  };
  for (const filename of Object.values(filenames)) {
    fs.writeFileSync(path.join(uploadsDir, filename), png);
  }

  const hiddenPost = Number(db.prepare(
    'INSERT INTO posts (user_id, content, hidden) VALUES (?, ?, 1)',
  ).run(ids.public, 'HIDDEN AVATAR BYPASS TEST').lastInsertRowid);
  const blockedPost = Number(db.prepare(
    'INSERT INTO posts (user_id, content) VALUES (?, ?)',
  ).run(ids.private, 'BLOCKED AVATAR BYPASS TEST').lastInsertRowid);
  const mediaIds = [
    Number(db.prepare("INSERT INTO post_media (post_id, media_type, url) VALUES (?, 'image', ?)").run(
      postIds.public, `/uploads/${filenames.other}`,
    ).lastInsertRowid),
    Number(db.prepare("INSERT INTO post_media (post_id, media_type, url) VALUES (?, 'image', ?)").run(
      postIds.private, `/uploads/${filenames.private}`,
    ).lastInsertRowid),
    Number(db.prepare("INSERT INTO post_media (post_id, media_type, url) VALUES (?, 'image', ?)").run(
      hiddenPost, `/uploads/${filenames.hidden}`,
    ).lastInsertRowid),
    Number(db.prepare("INSERT INTO post_media (post_id, media_type, url) VALUES (?, 'image', ?)").run(
      blockedPost, `/uploads/${filenames.blocked}`,
    ).lastInsertRowid),
  ];

  const original = db.prepare(
    'SELECT avatar_url, bio, is_verified FROM users WHERE id = ?',
  ).get(ids.stranger) as any;
  const providerAvatar = 'https://example.invalid/provider-avatar.png';
  const createdAvatarFiles: string[] = [];
  let collisionPost = 0;
  let collisionMedia = 0;

  const uploadAvatar = async (username: string) => {
    const form = new FormData();
    form.append('file', new Blob([png], { type: 'image/png' }), 'avatar.png');
    const result = await request('/api/uploads/avatar', username, { method: 'POST', body: form });
    if (result.body?.media?.url) createdAvatarFiles.push(path.basename(result.body.media.url));
    return result;
  };

  try {
    db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(providerAvatar, ids.stranger);
    db.prepare(`
      INSERT INTO user_auth_providers (
        user_id, provider, provider_user_id, provider_email, provider_display_name, provider_avatar_url
      ) VALUES (?, 'google', ?, ?, ?, ?)
    `).run(ids.stranger, 'avatar-provider-test', 'stranger@test.invalid', 'Stranger User', providerAvatar);

    const profileUpdate = await request('/api/users/profile', 'stranger', {
      method: 'PUT', body: JSON.stringify({ bio: 'provider avatar preserved' }),
    });
    assert.equal(profileUpdate.response.status, 200);
    assert.equal(
      (db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(ids.stranger) as any).avatar_url,
      providerAvatar,
    );

    const attempts = [filenames.other, filenames.private, filenames.hidden, filenames.blocked, filenames.orphan];
    for (const filename of attempts) {
      const result = await request('/api/users/profile', 'stranger', {
        method: 'PUT', body: JSON.stringify({ avatar_url: `/uploads/${filename}` }),
      });
      assert.equal(result.response.status, 400);
      assert.equal(
        (db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(ids.stranger) as any).avatar_url,
        providerAvatar,
      );
    }
    const externalAttempt = await request('/api/users/profile', 'stranger', {
      method: 'PUT', body: JSON.stringify({ avatar_url: 'https://attacker.invalid/avatar.png' }),
    });
    assert.equal(externalAttempt.response.status, 400);

    assert.equal((await request(`/uploads/${filenames.private}`)).response.status, 404);
    assert.equal((await request(`/uploads/${filenames.hidden}`)).response.status, 404);
    assert.equal((await request(`/uploads/${filenames.blocked}`, 'blocker')).response.status, 404);
    assert.equal((await request(`/uploads/${filenames.orphan}`)).response.status, 404);

    db.prepare('UPDATE users SET is_verified = 0 WHERE id = ?').run(ids.stranger);
    const unverifiedAttempt = await request('/api/users/profile', 'stranger', {
      method: 'PUT', body: JSON.stringify({ avatar_url: `/uploads/${filenames.private}` }),
    });
    assert.equal(unverifiedAttempt.response.status, 400);
    assert.equal((await request(`/uploads/${filenames.private}`)).response.status, 404);
    db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(original.is_verified, ids.stranger);

    const firstUpload = await uploadAvatar('stranger');
    assert.equal(firstUpload.response.status, 201);
    const firstUrl = firstUpload.body.media.url as string;
    assert.match(firstUrl, /^\/uploads\/asset-[a-f0-9]{32}\.png$/);
    assert.equal(
      (db.prepare('SELECT user_id FROM user_avatar_uploads WHERE url = ?').get(firstUrl) as any).user_id,
      ids.stranger,
    );
    assert.equal((await request(firstUrl)).response.status, 200);

    collisionPost = Number(db.prepare(
      'INSERT INTO posts (user_id, content, hidden) VALUES (?, ?, 1)',
    ).run(ids.stranger, 'AVATAR CLASSIFICATION COLLISION').lastInsertRowid);
    collisionMedia = Number(db.prepare(
      "INSERT INTO post_media (post_id, media_type, url) VALUES (?, 'image', ?)",
    ).run(collisionPost, firstUrl).lastInsertRowid);
    assert.equal((await request(firstUrl)).response.status, 200);
    db.prepare('DELETE FROM post_media WHERE id = ?').run(collisionMedia);
    collisionMedia = 0;
    assert.equal((await request(firstUrl)).response.status, 200);

    const secondUpload = await uploadAvatar('stranger');
    assert.equal(secondUpload.response.status, 201);
    const secondUrl = secondUpload.body.media.url as string;
    assert.notEqual(secondUrl, firstUrl);
    assert.equal((await request(firstUrl)).response.status, 404);
    assert.equal((db.prepare('SELECT state FROM managed_assets WHERE url = ?').get(firstUrl) as any).state, 'reclaimable');
    assert.equal((await request(secondUrl)).response.status, 200);
    assert.equal((db.prepare('SELECT state FROM managed_assets WHERE url = ?').get(secondUrl) as any).state, 'active');

    const reset = await request('/api/users/profile', 'stranger', {
      method: 'PUT', body: JSON.stringify({ avatar_url: '' }),
    });
    assert.equal(reset.response.status, 200);
    assert.equal(
      (db.prepare('SELECT avatar_url FROM users WHERE id = ?').get(ids.stranger) as any).avatar_url,
      '',
    );
    assert.equal((await request(secondUrl)).response.status, 404);
    assert.equal((db.prepare('SELECT state FROM managed_assets WHERE url = ?').get(secondUrl) as any).state, 'reclaimable');
  } finally {
    if (collisionMedia) db.prepare('DELETE FROM post_media WHERE id = ?').run(collisionMedia);
    if (collisionPost) db.prepare('DELETE FROM posts WHERE id = ?').run(collisionPost);
    db.prepare('DELETE FROM user_avatar_uploads WHERE user_id = ?').run(ids.stranger);
    db.prepare('DELETE FROM user_auth_providers WHERE user_id = ? AND provider_user_id = ?')
      .run(ids.stranger, 'avatar-provider-test');
    db.prepare('UPDATE users SET avatar_url = ?, bio = ?, is_verified = ? WHERE id = ?')
      .run(original.avatar_url, original.bio, original.is_verified, ids.stranger);
    for (const id of mediaIds) db.prepare('DELETE FROM post_media WHERE id = ?').run(id);
    db.prepare('DELETE FROM posts WHERE id IN (?, ?)').run(hiddenPost, blockedPost);
    for (const filename of [...Object.values(filenames), ...createdAvatarFiles]) {
      const filePath = path.join(uploadsDir, filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
});

test('group deletion authorization and sole-owner cleanup are explicit', async () => {
  const makeGroup = (name: string, ownerId = ids.public) => {
    const id = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)').run(name, ownerId).lastInsertRowid);
    db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(id, ownerId);
    return id;
  };
  const group = makeGroup('BATCH07 AUTH GROUP');
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(group, ids.follower);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(group, ids.stranger);

  assert.equal((await request(`/api/groups/${group}`, undefined, { method: 'DELETE' })).response.status, 401);
  for (const username of ['follower', 'stranger', 'blocker']) {
    const denied = await request(`/api/groups/${group}`, username, { method: 'DELETE' });
    assert.equal(denied.response.status, 404);
    assert.ok(db.prepare('SELECT 1 FROM groups_table WHERE id = ?').get(group));
    assert.equal((db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(group) as any).c, 3);
  }

  const ownerDelete = await request(`/api/groups/${group}`, 'public', { method: 'DELETE' });
  assert.equal(ownerDelete.response.status, 200);
  assert.equal(ownerDelete.body.deleted.contentPolicy, 'group-scoped-content-deleted');
  assert.equal((await request(`/api/groups/${group}`)).response.status, 404);
  assert.equal((await request(`/api/groups/${group}`, 'public', { method: 'DELETE' })).response.status, 404);

  const sole = makeGroup('BATCH07 SOLE GROUP');
  const leave = await request(`/api/groups/${sole}/leave`, 'public', { method: 'POST' });
  assert.equal(leave.response.status, 409);
  assert.match(leave.body.error, /Transfer ownership.*delete/i);
  assert.ok(db.prepare('SELECT 1 FROM groups_table WHERE id = ?').get(sole));
  assert.equal((await request(`/api/groups/${sole}`, 'public', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/groups/${sole}`)).response.status, 404);

  const adminDelete = makeGroup('BATCH07 SITE ADMIN GROUP');
  assert.equal((await request(`/api/groups/${adminDelete}`, 'admin', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/groups/${adminDelete}`)).response.status, 404);
});

test('group deletion removes the complete scoped graph and detaches managed media', async () => {
  const groupName = 'BATCH07 GRAPH GROUP';
  const group = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)').run(groupName, ids.public).lastInsertRowid);
  const memberships = [
    [ids.public, 'admin'], [ids.follower, 'admin'], [ids.stranger, 'member'],
  ] as const;
  for (const [userId, role] of memberships) {
    db.prepare('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)').run(group, userId, role);
  }
  const ownerPost = Number(db.prepare('INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)').run(ids.public, 'B07 OWNER GROUP POST', group).lastInsertRowid);
  const adminPost = Number(db.prepare('INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)').run(ids.follower, 'B07 ADMIN GROUP POST', group).lastInsertRowid);
  const memberPost = Number(db.prepare('INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)').run(ids.stranger, 'B07 MEMBER GROUP POST', group).lastInsertRowid);
  const comment = Number(db.prepare('INSERT INTO posts (user_id, content, parent_id) VALUES (?, ?, ?)').run(ids.follower, 'B07 COMMENT', memberPost).lastInsertRowid);
  const reply = Number(db.prepare('INSERT INTO posts (user_id, content, parent_id) VALUES (?, ?, ?)').run(ids.stranger, 'B07 REPLY', comment).lastInsertRowid);
  const repost = Number(db.prepare('INSERT INTO posts (user_id, content, repost_of) VALUES (?, ?, ?)').run(ids.blocker, '', ownerPost).lastInsertRowid);
  db.prepare("INSERT INTO likes (user_id, post_id, reaction_type) VALUES (?, ?, 'love')").run(ids.private, memberPost);
  const report = Number(db.prepare("INSERT INTO reports (reporter_id, post_id, reason) VALUES (?, ?, 'other')").run(ids.private, adminPost).lastInsertRowid);
  const postNotice = Number(db.prepare("INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'like', ?)").run(ids.public, ids.private, memberPost).lastInsertRowid);
  const groupNotice = Number(db.prepare("INSERT INTO notifications (user_id, actor_id, type, group_id) VALUES (?, ?, 'group_invite', ?)").run(ids.stranger, ids.public, group).lastInsertRowid);

  const assetId = '7'.repeat(32);
  const filename = `asset-${'7'.repeat(32)}.png`;
  const assetUrl = `/uploads/${filename}`;
  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, Buffer.from('batch07 managed file'));
  db.prepare(`INSERT INTO managed_assets
    (id, owner_user_id, storage_key, url, media_type, mime_type, file_size_bytes, sha256, purpose, state, created_at_ms)
    VALUES (?, ?, ?, ?, 'image', 'image/png', 20, ?, 'post_image', 'active', ?)`)
    .run(assetId, ids.stranger, filename, assetUrl, '0'.repeat(64), Date.now());
  db.prepare("INSERT INTO post_media (post_id, asset_id, media_type, url) VALUES (?, ?, 'image', ?)")
    .run(memberPost, assetId, assetUrl);

  const deleted = await request(`/api/groups/${group}`, 'public', { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.deleted.groupPostCount, 3);
  assert.equal(deleted.body.deleted.memberCount, 3);
  assert.equal(db.prepare('SELECT 1 FROM groups_table WHERE id = ?').get(group), undefined);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(group) as any).c, 0);
  for (const postId of [ownerPost, adminPost, memberPost, comment, reply, repost]) {
    assert.equal(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(postId), undefined);
    assert.equal((await request(`/api/posts/${postId}`, 'public')).response.status, 404);
  }
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM likes WHERE post_id = ?').get(memberPost) as any).c, 0);
  assert.equal(db.prepare('SELECT 1 FROM reports WHERE id = ?').get(report), undefined);
  assert.equal(db.prepare('SELECT 1 FROM notifications WHERE id IN (?, ?)').get(postNotice, groupNotice), undefined);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM post_media WHERE asset_id = ?').get(assetId) as any).c, 0);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(assetId) as any).state, 'reclaimable');
  assert.equal(fs.existsSync(filePath), true);
  assert.equal((await request(assetUrl, 'stranger')).response.status, 404);
  assert.equal((await request(`/api/uploads/post/${memberPost}`, 'stranger')).response.status, 404);

  const feed = await request('/api/feed?level=everyone', 'public');
  const serializedFeed = JSON.stringify(feed.body);
  for (const value of ['B07 OWNER GROUP POST', 'B07 ADMIN GROUP POST', 'B07 MEMBER GROUP POST']) {
    assert.equal(serializedFeed.includes(value), false);
  }
  const search = await request(`/api/groups?q=${encodeURIComponent(groupName)}`, 'public');
  assert.equal(search.body.groups.some((item: any) => item.id === group), false);
  const notices = await request('/api/notifications', 'public');
  assert.equal(notices.body.notifications.some((item: any) => item.id === postNotice || item.id === groupNotice), false);

  fs.unlinkSync(filePath);
  db.prepare('DELETE FROM managed_assets WHERE id = ?').run(assetId);
});

test('ownership transfer is atomic, member-only, replay-safe, and enables former-owner leave', async () => {
  const makeTransferGroup = (name: string) => {
    const id = Number(db.prepare('INSERT INTO groups_table (name, owner_id) VALUES (?, ?)').run(name, ids.public).lastInsertRowid);
    db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(id, ids.public);
    db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(id, ids.follower);
    db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(id, ids.stranger);
    db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(id, ids.banned);
    return id;
  };
  const group = makeTransferGroup('BATCH07 TRANSFER GROUP');
  const endpoint = `/api/groups/${group}/owner`;

  assert.equal((await request(endpoint, 'follower', { method: 'PUT', body: JSON.stringify({ userId: ids.stranger }) })).response.status, 404);
  assert.equal((db.prepare('SELECT owner_id FROM groups_table WHERE id = ?').get(group) as any).owner_id, ids.public);
  assert.equal((await request(endpoint, 'public', { method: 'PUT', body: JSON.stringify({ userId: ids.blocker }) })).response.status, 404);
  assert.equal((await request(endpoint, 'public', { method: 'PUT', body: JSON.stringify({ userId: ids.banned }) })).response.status, 404);
  assert.equal((await request(endpoint, 'public', { method: 'PUT', body: JSON.stringify({ userId: 999999 }) })).response.status, 404);

  const transferred = await request(endpoint, 'public', { method: 'PUT', body: JSON.stringify({ userId: ids.stranger }) });
  assert.equal(transferred.response.status, 200);
  assert.equal(transferred.body.previousOwnerRole, 'admin');
  assert.equal((db.prepare('SELECT owner_id FROM groups_table WHERE id = ?').get(group) as any).owner_id, ids.stranger);
  assert.equal((db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(group, ids.public) as any).role, 'admin');
  assert.equal((db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(group, ids.stranger) as any).role, 'admin');

  assert.equal((await request(endpoint, 'public', { method: 'PUT', body: JSON.stringify({ userId: ids.stranger }) })).response.status, 404);
  const replay = await request(endpoint, 'admin', { method: 'PUT', body: JSON.stringify({ userId: ids.stranger }) });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await request(`/api/groups/${group}`, 'public', { method: 'DELETE' })).response.status, 404);
  assert.equal((await request(`/api/groups/${group}/leave`, 'public', { method: 'POST' })).response.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(group, ids.public), undefined);
  assert.equal((await request(`/api/groups/${group}/leave`, 'stranger', { method: 'POST' })).response.status, 409);
  assert.equal((db.prepare('SELECT owner_id FROM groups_table WHERE id = ?').get(group) as any).owner_id, ids.stranger);
  assert.equal((await request(`/api/groups/${group}`, 'stranger', { method: 'DELETE' })).response.status, 200);

  const failingGroup = makeTransferGroup('BATCH07 FAILING TRANSFER');
  db.exec(`CREATE TRIGGER batch07_abort_transfer BEFORE UPDATE OF owner_id ON groups_table
    WHEN OLD.id = ${failingGroup} BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END`);
  try {
    const failed = await request(`/api/groups/${failingGroup}/owner`, 'public', {
      method: 'PUT', body: JSON.stringify({ userId: ids.stranger }),
    });
    assert.equal(failed.response.status, 500);
    assert.equal((db.prepare('SELECT owner_id FROM groups_table WHERE id = ?').get(failingGroup) as any).owner_id, ids.public);
    assert.equal((db.prepare('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?').get(failingGroup, ids.stranger) as any).role, 'member');
  } finally {
    db.exec('DROP TRIGGER batch07_abort_transfer');
    db.prepare('DELETE FROM groups_table WHERE id = ?').run(failingGroup);
  }
});

test('admin account deletion requires explicit resolution of every owned group', async () => {
  const ownerId = Number(db.prepare(`INSERT INTO users
    (username, display_name, email, password_hash, is_verified)
    VALUES ('batch07account', 'Batch 07 Account', 'batch07account@test.invalid', 'x', 1)`).run().lastInsertRowid);
  const emptyGroup = Number(db.prepare("INSERT INTO groups_table (name, owner_id) VALUES ('B07 ACCOUNT EMPTY', ?)").run(ownerId).lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(emptyGroup, ownerId);
  const sharedGroup = Number(db.prepare("INSERT INTO groups_table (name, owner_id) VALUES ('B07 ACCOUNT SHARED', ?)").run(ownerId).lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(sharedGroup, ownerId);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'member')").run(sharedGroup, ids.stranger);
  const ownerPost = Number(db.prepare('INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)').run(ownerId, 'B07 ACCOUNT OWNER POST', sharedGroup).lastInsertRowid);
  const memberPost = Number(db.prepare('INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)').run(ids.stranger, 'B07 ACCOUNT MEMBER POST', sharedGroup).lastInsertRowid);

  const blocked = await request(`/api/admin/users/${ownerId}`, 'admin', { method: 'DELETE' });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.ownedGroups.length, 2);
  assert.ok(db.prepare('SELECT 1 FROM users WHERE id = ?').get(ownerId));
  assert.ok(db.prepare('SELECT 1 FROM groups_table WHERE id = ?').get(emptyGroup));
  assert.ok(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(memberPost));

  assert.equal((await request(`/api/groups/${emptyGroup}`, 'admin', { method: 'DELETE' })).response.status, 200);
  assert.equal((await request(`/api/groups/${sharedGroup}/owner`, 'admin', {
    method: 'PUT', body: JSON.stringify({ userId: ids.stranger }),
  })).response.status, 200);
  const deleted = await request(`/api/admin/users/${ownerId}`, 'admin', { method: 'DELETE' });
  assert.equal(deleted.response.status, 200);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(ownerId), undefined);
  assert.equal((db.prepare('SELECT owner_id FROM groups_table WHERE id = ?').get(sharedGroup) as any).owner_id, ids.stranger);
  assert.equal(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(ownerPost), undefined);
  assert.ok(db.prepare('SELECT 1 FROM posts WHERE id = ?').get(memberPost));
  assert.equal((await request(`/api/groups/${sharedGroup}`, 'admin', { method: 'DELETE' })).response.status, 200);
});

test('managed assets enforce ownership, idempotency, visibility, and deferred reclamation', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
  const upload = async (username: string, bytes = png, name = 'owned.png', type = 'image/png') => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    return request('/api/uploads/image', username, { method: 'POST', body: form });
  };
  const postKey = 'asset-lifecycle-post-key';
  const created = await request('/api/posts', 'stranger', {
    method: 'POST', body: JSON.stringify({ content: 'MANAGED ASSET TEST', clientSubmissionKey: postKey }),
  });
  assert.equal(created.response.status, 201);
  const postId = created.body.post.id as number;
  const replay = await request('/api/posts', 'stranger', {
    method: 'POST', body: JSON.stringify({ content: 'MANAGED ASSET TEST', clientSubmissionKey: postKey }),
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.post.id, postId);
  assert.equal(replay.body.replayed, true);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM posts WHERE content = ?').get('MANAGED ASSET TEST') as any).c, 1);
  const keyConflict = await request('/api/posts', 'stranger', {
    method: 'POST', body: JSON.stringify({ content: 'DIFFERENT', clientSubmissionKey: postKey }),
  });
  assert.equal(keyConflict.response.status, 409);
  const otherUserKey = await request('/api/posts', 'follower', {
    method: 'POST', body: JSON.stringify({ content: 'OTHER USER SAME KEY', clientSubmissionKey: postKey }),
  });
  assert.equal(otherUserKey.response.status, 201);
  assert.notEqual(otherUserKey.body.post.id, postId);
  const boundedKey = 'bounded-retention-key';
  const boundedFirst = await request('/api/posts', 'stranger', {
    method: 'POST', body: JSON.stringify({ content: 'BOUNDED IDEMPOTENCY', clientSubmissionKey: boundedKey }),
  });
  assert.equal(boundedFirst.response.status, 201);
  db.prepare('UPDATE post_submission_keys SET expires_at_ms = ? WHERE user_id = ? AND submission_key = ?')
    .run(Date.now() - 1, ids.stranger, boundedKey);
  const boundedAfterExpiry = await request('/api/posts', 'stranger', {
    method: 'POST', body: JSON.stringify({ content: 'BOUNDED IDEMPOTENCY', clientSubmissionKey: boundedKey }),
  });
  assert.equal(boundedAfterExpiry.response.status, 201);
  assert.notEqual(boundedAfterExpiry.body.post.id, boundedFirst.body.post.id);

  const staged = await upload('stranger');
  assert.equal(staged.response.status, 201);
  const assetId = staged.body.asset.id as string;
  const assetUrl = staged.body.asset.url as string;
  const filename = path.basename(assetUrl);
  assert.match(assetId, /^[a-f0-9]{32}$/);
  assert.match(filename, /^asset-[a-f0-9]{32}\.png$/);
  const row = db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(assetId) as any;
  assert.equal(row.owner_user_id, ids.stranger);
  assert.equal(row.purpose, 'pending_post_image');
  assert.equal(row.state, 'pending');
  assert.equal(row.file_size_bytes, png.length);
  assert.match(row.sha256, /^[a-f0-9]{64}$/);
  assert.equal((await request(assetUrl)).response.status, 404);
  assert.equal((await request(assetUrl, 'stranger')).response.status, 200);

  const foreignPost = Number(db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(ids.follower, 'FOREIGN TARGET').lastInsertRowid);
  const hiddenPost = Number(db.prepare('INSERT INTO posts (user_id, content, hidden) VALUES (?, ?, 1)').run(ids.stranger, 'HIDDEN TARGET').lastInsertRowid);
  assert.equal((await request(`/api/uploads/assets/${assetId}/attach`, 'follower', {
    method: 'POST', body: JSON.stringify({ postId: foreignPost }),
  })).response.status, 404);
  assert.equal((await request(`/api/uploads/assets/${assetId}/attach`, 'stranger', {
    method: 'POST', body: JSON.stringify({ postId: foreignPost }),
  })).response.status, 404);
  assert.equal((await request(`/api/uploads/assets/${assetId}/attach`, 'stranger', {
    method: 'POST', body: JSON.stringify({ postId: hiddenPost }),
  })).response.status, 404);
  assert.equal((await request(`/api/uploads/assets/${assetId}/attach`, 'stranger', {
    method: 'POST', body: JSON.stringify({ postId: 999999 }),
  })).response.status, 404);

  const attached = await request(`/api/uploads/assets/${assetId}/attach`, 'stranger', {
    method: 'POST', body: JSON.stringify({ postId, altText: 'managed test image' }),
  });
  assert.equal(attached.response.status, 201);
  const attachedReplay = await request(`/api/uploads/assets/${assetId}/attach`, 'stranger', {
    method: 'POST', body: JSON.stringify({ postId, altText: 'ignored on replay' }),
  });
  assert.equal(attachedReplay.response.status, 200);
  assert.equal(attachedReplay.body.media.id, attached.body.media.id);
  assert.equal(attachedReplay.body.replayed, true);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM post_media WHERE asset_id = ?').get(assetId) as any).c, 1);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(assetId) as any).state, 'active');
  assert.equal((await request(assetUrl)).response.status, 200);
  // Pending expiry never detaches an active reference.
  const activeExpiryPass = reclaimManagedAssets(db, { uploadsDir, nodeEnv: 'test', nowMs: Date.now() + 2 * 60 * 60 * 1000 });
  assert.equal(activeExpiryPass.disabled, true);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(assetId) as any).state, 'active');
  // Even an inconsistent reclaimable state cannot delete a referenced file.
  db.prepare('UPDATE managed_assets SET state = ?, reclaim_after_ms = ? WHERE id = ?').run('reclaimable', Date.now() - 1, assetId);
  const referencedGuard = reclaimManagedAssets(db, { uploadsDir, nodeEnv: 'test', allowPhysicalDeletion: true });
  assert.ok(referencedGuard.failed >= 1);
  assert.equal(fs.existsSync(path.join(uploadsDir, filename)), true);
  db.prepare("UPDATE managed_assets SET state = 'active', reclaim_after_ms = NULL, last_reclaim_error = '' WHERE id = ?").run(assetId);

  const videoKey = 'external-video-retry-key';
  const videoBody = JSON.stringify({
    postId, attachmentKey: videoKey, url: 'https://www.youtube.com/watch?v=abcdefghijk',
  });
  const video = await request('/api/uploads/external-video', 'stranger', { method: 'POST', body: videoBody });
  const videoReplay = await request('/api/uploads/external-video', 'stranger', { method: 'POST', body: videoBody });
  assert.equal(video.response.status, 201);
  assert.equal(videoReplay.response.status, 200);
  assert.equal(videoReplay.body.media.id, video.body.media.id);
  assert.equal((db.prepare('SELECT COUNT(*) AS c FROM post_media WHERE post_id = ? AND attachment_key = ?').get(postId, videoKey) as any).c, 1);

  const deletion = await request(`/api/posts/${postId}`, 'stranger', { method: 'DELETE' });
  assert.equal(deletion.response.status, 200);
  const detached = db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(assetId) as any;
  assert.equal(detached.state, 'reclaimable');
  assert.equal(fs.existsSync(path.join(uploadsDir, filename)), true);
  assert.equal((await request(assetUrl, 'stranger')).response.status, 404);

  db.prepare('UPDATE managed_assets SET reclaim_after_ms = ? WHERE id = ?').run(Date.now() - 1, assetId);
  const disabled = reclaimManagedAssets(db, {
    uploadsDir, nodeEnv: 'production', allowPhysicalDeletion: true, nowMs: Date.now(),
  });
  assert.equal(disabled.disabled, true);
  assert.equal(fs.existsSync(path.join(uploadsDir, filename)), true);
  const failed = reclaimManagedAssets(db, {
    uploadsDir, nodeEnv: 'test', allowPhysicalDeletion: true, nowMs: Date.now(),
    unlinkFile: () => { throw new Error('simulated unlink failure'); },
  });
  assert.equal(failed.failed, 1);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(assetId) as any).state, 'reclaimable');
  const reclaimed = reclaimManagedAssets(db, {
    uploadsDir, nodeEnv: 'test', allowPhysicalDeletion: true, nowMs: Date.now(),
  });
  assert.equal(reclaimed.deleted, 1);
  assert.equal(fs.existsSync(path.join(uploadsDir, filename)), false);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(assetId) as any).state, 'deleted');

  const abandoned = await upload('stranger');
  const abandonedId = abandoned.body.asset.id as string;
  const abandonedFile = path.basename(abandoned.body.asset.url);
  db.prepare('UPDATE managed_assets SET pending_expires_at_ms = ? WHERE id = ?').run(Date.now() - 1, abandonedId);
  const expired = reclaimManagedAssets(db, { uploadsDir, nodeEnv: 'test', nowMs: Date.now() });
  assert.equal(expired.disabled, true);
  assert.ok(expired.pendingExpired >= 1);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(abandonedId) as any).state, 'reclaimable');
  assert.equal((await request(abandoned.body.asset.url, 'stranger')).response.status, 404);
  const expiredTarget = Number(db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(ids.stranger, 'EXPIRED ASSET TARGET').lastInsertRowid);
  assert.equal((await request(`/api/uploads/assets/${abandonedId}/attach`, 'stranger', {
    method: 'POST', body: JSON.stringify({ postId: expiredTarget }),
  })).response.status, 410);

  const mismatch = await upload('stranger', png, 'mismatch.jpg', 'image/jpeg');
  assert.equal(mismatch.response.status, 400);
  const malformed = await upload('stranger', Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.equal(malformed.response.status, 400);
  const invalidMime = await upload('stranger', Buffer.from('<script>'), 'payload.png', 'text/html');
  assert.equal(invalidMime.response.status, 400);
  const oversized = await upload('stranger', Buffer.alloc(5 * 1024 * 1024 + 1), 'large.png', 'image/png');
  assert.equal(oversized.response.status, 400);
  const protectedUpload = await upload('private');
  const protectedAssetId = protectedUpload.body.asset.id as string;
  const protectedUrl = protectedUpload.body.asset.url as string;
  const protectedPost = Number(db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(ids.private, 'PRIVATE MANAGED ASSET').lastInsertRowid);
  assert.equal((await request(`/api/uploads/assets/${protectedAssetId}/attach`, 'private', {
    method: 'POST', body: JSON.stringify({ postId: protectedPost }),
  })).response.status, 201);
  assert.equal((await request(protectedUrl)).response.status, 404);
  assert.equal((await request(protectedUrl, 'blocker')).response.status, 404);
  const adoption = await request('/api/users/profile', 'stranger', {
    method: 'PUT', body: JSON.stringify({ avatar_url: protectedUrl }),
  });
  assert.equal(adoption.response.status, 400);
  assert.equal((await request(protectedUrl)).response.status, 404);
  db.prepare('DELETE FROM posts WHERE id = ?').run(protectedPost);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(protectedAssetId) as any).state, 'reclaimable');
  const protectedPath = path.join(uploadsDir, path.basename(protectedUrl));
  if (fs.existsSync(protectedPath)) fs.unlinkSync(protectedPath);
  db.prepare('DELETE FROM managed_assets WHERE id = ?').run(protectedAssetId);

  const oldCombined = new FormData();
  oldCombined.append('file', new Blob([png], { type: 'image/png' }), 'old.png');
  oldCombined.append('postId', String(foreignPost));
  assert.equal((await request('/api/uploads/image', 'stranger', { method: 'POST', body: oldCombined })).response.status, 400);

  db.prepare('DELETE FROM posts WHERE id IN (?, ?, ?)').run(foreignPost, hiddenPost, expiredTarget);
  db.prepare('DELETE FROM posts WHERE id = ?').run(otherUserKey.body.post.id);
  db.prepare('DELETE FROM posts WHERE id IN (?, ?)').run(boundedFirst.body.post.id, boundedAfterExpiry.body.post.id);
  const unsafeId = 'd'.repeat(32);
  db.prepare(`INSERT INTO managed_assets
    (id, owner_user_id, storage_key, url, media_type, mime_type, file_size_bytes, sha256, purpose, state, created_at_ms, reclaim_after_ms)
    VALUES (?, ?, '../outside.png', '/uploads/outside.png', 'image', 'image/png', 1, ?, 'post_image', 'reclaimable', ?, ?)`)
    .run(unsafeId, ids.stranger, '0'.repeat(64), Date.now() - 10000, Date.now() - 1);
  const unsafe = reclaimManagedAssets(db, { uploadsDir, nodeEnv: 'test', allowPhysicalDeletion: true });
  assert.ok(unsafe.failed >= 1);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(unsafeId) as any).state, 'reclaimable');

  const symlinkId = 'e'.repeat(32);
  const symlinkName = `asset-${'e'.repeat(32)}.png`;
  const symlinkPath = path.join(uploadsDir, symlinkName);
  fs.symlinkSync('/etc/hosts', symlinkPath);
  db.prepare(`INSERT INTO managed_assets
    (id, owner_user_id, storage_key, url, media_type, mime_type, file_size_bytes, sha256, purpose, state, created_at_ms, reclaim_after_ms)
    VALUES (?, ?, ?, ?, 'image', 'image/png', 1, ?, 'post_image', 'reclaimable', ?, ?)`)
    .run(symlinkId, ids.stranger, symlinkName, `/uploads/${symlinkName}`, '0'.repeat(64), Date.now() - 10000, Date.now() - 1);
  const symlinkResult = reclaimManagedAssets(db, { uploadsDir, nodeEnv: 'test', allowPhysicalDeletion: true });
  assert.ok(symlinkResult.failed >= 1);
  assert.equal(fs.lstatSync(symlinkPath).isSymbolicLink(), true);

  const untrackedName = `asset-${'f'.repeat(32)}.png`;
  const untrackedPath = path.join(uploadsDir, untrackedName);
  fs.writeFileSync(untrackedPath, png);
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  fs.utimesSync(untrackedPath, old, old);
  const untracked = reclaimManagedAssets(db, {
    uploadsDir, nodeEnv: 'test', allowPhysicalDeletion: true, nowMs: Date.now(),
  });
  assert.equal(untracked.untrackedDeleted, 1);
  assert.equal(fs.existsSync(untrackedPath), false);

  const abandonedPath = path.join(uploadsDir, abandonedFile);
  if (fs.existsSync(abandonedPath)) fs.unlinkSync(abandonedPath);
  if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
  db.prepare('DELETE FROM managed_assets WHERE id IN (?, ?, ?, ?)').run(assetId, abandonedId, unsafeId, symlinkId);
});

test('account and group cascades detach managed references without deleting files', () => {
  const userId = Number(db.prepare(`INSERT INTO users
    (username, display_name, email, password_hash, is_verified, avatar_url)
    VALUES ('assetcascade', 'Asset Cascade', 'assetcascade@test.invalid', 'x', 1, '/uploads/asset-cascade-avatar.png')`).run().lastInsertRowid);
  const group = Number(db.prepare("INSERT INTO groups_table (name, owner_id) VALUES ('ASSET CASCADE GROUP', ?)").run(userId).lastInsertRowid);
  db.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'admin')").run(group, userId);
  const directPost = Number(db.prepare('INSERT INTO posts (user_id, content) VALUES (?, ?)').run(userId, 'ACCOUNT CASCADE POST').lastInsertRowid);
  const groupPost = Number(db.prepare('INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)').run(userId, 'GROUP CASCADE POST', group).lastInsertRowid);
  const rows = [
    ['1'.repeat(32), `asset-${'1'.repeat(32)}.png`, 'post_image', directPost],
    ['2'.repeat(32), `asset-${'2'.repeat(32)}.png`, 'post_image', groupPost],
    ['3'.repeat(32), `asset-${'3'.repeat(32)}.png`, 'avatar', null],
  ] as const;
  for (const [id, filename, purpose, postId] of rows) {
    const url = `/uploads/${filename}`;
    fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from('asset cascade'));
    db.prepare(`INSERT INTO managed_assets
      (id, owner_user_id, storage_key, url, media_type, mime_type, file_size_bytes, sha256, purpose, state, created_at_ms)
      VALUES (?, ?, ?, ?, 'image', 'image/png', 13, ?, ?, 'active', ?)`)
      .run(id, userId, filename, url, '0'.repeat(64), purpose, Date.now());
    if (postId) db.prepare("INSERT INTO post_media (post_id, asset_id, media_type, url) VALUES (?, ?, 'image', ?)").run(postId, id, url);
    else db.prepare('INSERT INTO user_avatar_uploads (user_id, asset_id, url, mime_type, file_size_bytes) VALUES (?, ?, ?, ?, ?)').run(userId, id, url, 'image/png', 13);
  }

  db.prepare('DELETE FROM groups_table WHERE id = ?').run(group);
  assert.equal((db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(rows[1][0]) as any).state, 'reclaimable');
  assert.equal(fs.existsSync(path.join(uploadsDir, rows[1][1])), true);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  for (const [id, filename] of rows) {
    const asset = db.prepare('SELECT state, owner_user_id FROM managed_assets WHERE id = ?').get(id) as any;
    assert.equal(asset.state, 'reclaimable');
    assert.equal(asset.owner_user_id, null);
    assert.equal(fs.existsSync(path.join(uploadsDir, filename)), true);
    fs.unlinkSync(path.join(uploadsDir, filename));
    db.prepare('DELETE FROM managed_assets WHERE id = ?').run(id);
  }
});

test('historical management lists and nested references cannot expose hidden actors or groups', async () => {
  const relation = db.prepare(`INSERT OR IGNORE INTO user_relationship_blocks
    (blocker_user_id, blocked_user_id, relationship_type) VALUES (?, ?, ?)`);
  relation.run(ids.blocker, ids.banned, 'block');
  relation.run(ids.blocker, ids.private, 'mute');
  relation.run(ids.blocker, ids.banned, 'mute');
  const post = Number(db.prepare('INSERT INTO posts (user_id, content, group_id) VALUES (?, ?, ?)').run(ids.public, 'PUBLIC GROUP CONTEXT', privateOwnedGroupId).lastInsertRowid);
  const notification = Number(db.prepare(`INSERT INTO notifications (user_id, actor_id, type, group_id)
    VALUES (?, ?, 'group_invite', ?)`).run(ids.blocker, ids.public, privateOwnedGroupId).lastInsertRowid);
  try {
    const blocked = await request('/api/users/blocked/list', 'blocker');
    assert.equal(blocked.body.blocked.some((u: any) => u.username === 'banned'), false);
    const muted = await request('/api/users/muted/list', 'blocker');
    assert.deepEqual(muted.body.muted, []);
    const item = await request(`/api/posts/${post}`, 'blocker');
    assert.equal(item.response.status, 200);
    assert.equal(item.body.post.groupId, null);
    const notices = await request('/api/notifications', 'blocker');
    assert.equal(notices.body.notifications.find((n: any) => n.id === notification).group_id, null);
    for (const action of ['block', 'mute']) {
      const missing = await request(`/api/users/999999/${action}`, 'stranger', { method: 'POST' });
      const hidden = await request(`/api/users/${ids.banned}/${action}`, 'stranger', { method: 'POST' });
      assert.equal(hidden.response.status, missing.response.status);
      assert.deepEqual(hidden.body, missing.body);
    }
  } finally {
    db.prepare('DELETE FROM posts WHERE id = ?').run(post);
    db.prepare('DELETE FROM notifications WHERE id = ?').run(notification);
    db.prepare("DELETE FROM user_relationship_blocks WHERE relationship_type = 'mute' OR blocked_user_id = ?").run(ids.banned);
  }
});

test('private DM settings stay undisclosed on denied initiation', async () => {
  const original = db.prepare('SELECT dm_privacy FROM users WHERE id = ?').get(ids.private) as any;
  try {
    for (const setting of ['noone', 'friends', 'friends_of_friends']) {
      db.prepare('UPDATE users SET dm_privacy = ? WHERE id = ?').run(setting, ids.private);
      const result = await request('/api/messages', 'stranger', { method: 'POST', body: JSON.stringify({ userId: ids.private }) });
      assert.equal(result.response.status, 403);
      assert.deepEqual(result.body, { error: 'Cannot message this user.' });
    }
  } finally {
    db.prepare('UPDATE users SET dm_privacy = ? WHERE id = ?').run(original.dm_privacy, ids.private);
  }
});

test('administrative pagination rejects malformed and overflowing page inputs', async () => {
  for (const value of ['-1', 'NaN', 'Infinity', '1.5', '1e300', '99999999999999999999999999999999', '999999999']) {
    const result = await request(`/api/admin/users?page=${value}&limit=${value}`, 'admin');
    assert.equal(result.response.status, 200, value);
    assert.ok(result.body.users.length <= 100);
  }
});

test('deep and cyclic reply ancestry fails closed within a fixed work bound', async () => {
  const chain: number[] = [];
  let parent = postIds.public;
  for (let i = 0; i < 70; i++) {
    parent = Number(db.prepare('INSERT INTO posts (user_id, content, parent_id) VALUES (?, ?, ?)').run(ids.public, 'DEEP REPLY', parent).lastInsertRowid);
    chain.push(parent);
  }
  try {
    assert.equal((await request(`/api/posts/${parent}`)).response.status, 404);
    db.prepare('UPDATE posts SET parent_id = ? WHERE id = ?').run(parent, chain[0]);
    assert.equal((await request(`/api/posts/${chain[0]}`)).response.status, 404);
  } finally {
    db.prepare('UPDATE posts SET parent_id = NULL WHERE id = ?').run(chain[0]);
    for (const id of chain.reverse()) db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  }
});
