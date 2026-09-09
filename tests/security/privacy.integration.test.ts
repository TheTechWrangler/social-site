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
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
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
  fs.writeFileSync(path.join(uploadsDir, filename), Buffer.from('89504e470d0a1a0a', 'hex'));
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
