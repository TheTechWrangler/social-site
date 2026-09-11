import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPostEntityMutation } from '../../src/postEntityState.js';
import { timestampOrder } from '../../src/timestampOrder.js';
import { feedTimeSql } from '../../server/feedTime.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refugecloud-batch14-workload-'));
Object.assign(process.env, { NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', DATABASE_PATH: path.join(root, 'test.db'), UPLOADS_DIR: path.join(root, 'uploads') });
let db: ReturnType<typeof import('../../server/database.js')['getDb']>;
let enrichPosts: typeof import('../../server/routes/posts.js')['enrichPosts'];
let initialize: () => void;
before(async () => {
  const database = await import('../../server/database.js');
  initialize = database.initializeDatabase;
  initialize(); db = database.getDb();
  enrichPosts = (await import('../../server/routes/posts.js')).enrichPosts;
});
after(() => { db?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('native page enrichment query count is constant while counts/media remain correct', () => {
  const author = Number(db.prepare("INSERT INTO users (username, display_name, email, password_hash, is_verified) VALUES ('author', 'Author', 'author@test.invalid', 'fixture', 1)").run().lastInsertRowid);
  const viewer = Number(db.prepare("INSERT INTO users (username, display_name, email, password_hash, is_verified) VALUES ('viewer', 'Viewer', 'viewer@test.invalid', 'fixture', 1)").run().lastInsertRowid);
  for (let i = 0; i < 50; i++) {
    const post = Number(db.prepare("INSERT INTO posts (user_id, content) VALUES (?, 'post')").run(author).lastInsertRowid);
    db.prepare("INSERT INTO posts (user_id, content, parent_id) VALUES (?, 'comment', ?)").run(viewer, post);
    db.prepare("INSERT INTO likes (post_id, user_id, reaction_type) VALUES (?, ?, 'love')").run(post, viewer);
    db.prepare("INSERT INTO post_media (post_id, media_type, url, alt_text) VALUES (?, 'image', '/fixture.png', 'A fox')").run(post);
  }
  const rows = db.prepare('SELECT p.*, u.username, u.display_name, u.avatar_url FROM posts p JOIN users u ON u.id = p.user_id WHERE p.parent_id IS NULL').all();
  const prepare = db.prepare;
  const measure = (count: number) => {
    let queries = 0;
    db.prepare = function (...args: any[]) { queries++; return prepare.apply(this, args as any); } as any;
    try { return { posts: enrichPosts(rows.slice(0, count), { id: viewer, role: 'user' }), queries }; }
    finally { db.prepare = prepare; }
  };
  const one = measure(1), fifty = measure(50);
  assert.equal(fifty.queries, one.queries);
  assert.ok(fifty.queries <= 6, String(fifty.queries));
  assert.equal(fifty.posts.length, 50);
  for (const post of fifty.posts) {
    assert.equal(post.commentCount, 1); assert.equal(post.reactions.love, 1);
    assert.equal(post.userReaction, 'love'); assert.equal(post.media[0].alt_text, 'A fox');
    assert.equal(post.media[0].canEditAlt, false);
    assert.equal(post.media[0].attachment_key, undefined);
  }
});

test('fetch-status migration and workload indexes are idempotent without rewriting source URLs', () => {
  db.prepare("INSERT INTO rss_sources (name, url) VALUES ('legacy', 'http://localhost/unsafe')").run();
  initialize(); initialize();
  const columns = db.prepare('PRAGMA table_info(rss_sources)').all() as any[];
  assert.equal(columns.filter(c => c.name === 'last_fetch_error').length, 1);
  assert.equal(columns.filter(c => c.name === 'last_fetch_attempt_at').length, 1);
  assert.equal((db.prepare("SELECT url FROM rss_sources WHERE name = 'legacy'").get() as any).url, 'http://localhost/unsafe');
});

test('appending comment pages preserves duplicate IDs, edited text and media descriptions', () => {
  const post = { id: 1, comments: [{ id: 2, content: 'new text', editVersion: 2, media: [{ id: 3, alt_text: 'new description' }] }] };
  const next = applyPostEntityMutation([post], { type: 'comments-loaded', postId: 1, append: true,
    comments: [{ id: 2, content: 'stale', editVersion: 0, media: [] }, { id: 4, content: 'next' }] })[0];
  assert.deepEqual(next.comments.map(c => c.id), [2, 4]);
  assert.equal(next.comments[0].content, 'new text');
  assert.equal(next.comments[0].media[0].alt_text, 'new description');
  const refreshed = applyPostEntityMutation([post], { type: 'comments-loaded', postId: 1,
    comments: [{ id: 2, content: 'old text', editVersion: 0, media: [{ id: 3, alt_text: 'old description' }] }] })[0];
  assert.equal(refreshed.comments[0].media[0].alt_text, 'new description');
  assert.equal(refreshed.comments[0].content, 'new text');
});

test('relative and malformed timestamps cannot destabilize SQL or client ordering', () => {
  const dates = ['2026-09-11 12:00:00', '2026-09-11T12:00:00.000Z'];
  assert.equal(timestampOrder(dates[0]), timestampOrder(dates[1]));
  for (const value of ['now', 'today', 'invalid', '']) {
    assert.equal(timestampOrder(value), 0);
    assert.equal((db.prepare(`SELECT ${feedTimeSql('stamp')} AS value FROM (SELECT ? AS stamp)`).get(value) as any).value, 0);
  }
  const user = (db.prepare('SELECT id FROM users LIMIT 1').get() as any).id;
  assert.doesNotThrow(() => db.prepare("INSERT INTO posts (user_id, content, created_at) VALUES (?, 'legacy date', 'now')").run(user));
});
