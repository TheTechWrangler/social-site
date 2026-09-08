import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

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
let gameId = 0;
let rssItemId = 0;
let blockedConversationId = 0;
let bannedConversationId = 0;
const postIds: Record<string, number> = {};

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
  addLfg.run(ids.private, gameId, 'PRIVATE AUTHOR PUBLIC LFG', 'public lfg body');
  addLfg.run(ids.banned, gameId, 'BANNED LFG SECRET', 'banned lfg body');

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
  addWorldComment.run(rssItemId, ids.private, 'PRIVATE AUTHOR PUBLIC WORLD COMMENT');
  addWorldComment.run(rssItemId, ids.banned, 'BANNED WORLD COMMENT SECRET');

  const addNotification = db.prepare(`
    INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, 'comment', ?)
  `);
  addNotification.run(ids.blocker, ids.public, postIds.public);
  addNotification.run(ids.blocker, ids.private, postIds.privateComment);
  addNotification.run(ids.blocker, ids.banned, postIds.bannedComment);

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
  addMessage.run(blockedConversationId, ids.private, 'BLOCKED MESSAGE SECRET');

  bannedConversationId = Number(addConversation.run().lastInsertRowid);
  addConversationMember.run(bannedConversationId, ids.blocker);
  addConversationMember.run(bannedConversationId, ids.banned);
  addMessage.run(bannedConversationId, ids.banned, 'BANNED MESSAGE SECRET');
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
  assert.deepEqual(anonymous.body.comments.map((comment: any) => comment.username), ['private']);

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
});
