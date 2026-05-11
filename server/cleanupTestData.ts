import 'dotenv/config';
import { initializeDatabase, getDb } from './database.js';

initializeDatabase();
const db = getDb();

const TEST_USER_PATTERNS = [
  'privacy_owner_%',
  'privacy_viewer_%',
  'conn_a_%',
  'conn_b_%',
  'conn_blocked_%',
  'conn_unverified_%',
];
const TEST_POST_PATTERNS = [
  'block test %',
];

function orLike(column: string, patterns: string[]): string {
  return patterns.map(() => `${column} LIKE ?`).join(' OR ');
}

const testUsers = db.prepare(`
  SELECT id, username FROM users
  WHERE ${orLike('username', TEST_USER_PATTERNS)}
`).all(...TEST_USER_PATTERNS) as Array<{ id: number; username: string }>;

const userIds = testUsers.map(u => u.id);
const userPlaceholders = userIds.map(() => '?').join(',');

const postWhereParts = [orLike('content', TEST_POST_PATTERNS)];
const postParams: any[] = [...TEST_POST_PATTERNS];
if (userIds.length > 0) {
  postWhereParts.push(`user_id IN (${userPlaceholders})`);
  postParams.push(...userIds);
}

const testPosts = db.prepare(`
  SELECT id, content FROM posts
  WHERE ${postWhereParts.map(p => `(${p})`).join(' OR ')}
`).all(...postParams) as Array<{ id: number; content: string }>;

const postIds = testPosts.map(p => p.id);
const reportWhereParts: string[] = [];
const reportParams: any[] = [];
if (userIds.length > 0) {
  reportWhereParts.push(`reporter_id IN (${userPlaceholders})`);
  reportParams.push(...userIds);
}
if (postIds.length > 0) {
  reportWhereParts.push(`post_id IN (${postIds.map(() => '?').join(',')})`);
  reportParams.push(...postIds);
}

const reportsDeleted = reportWhereParts.length > 0
  ? (db.prepare(`SELECT COUNT(*) as c FROM reports WHERE ${reportWhereParts.join(' OR ')}`).get(...reportParams) as any).c as number
  : 0;

const cleanup = db.transaction(() => {
  let postsDeleted = 0;
  for (const pattern of TEST_POST_PATTERNS) {
    postsDeleted += db.prepare('DELETE FROM posts WHERE content LIKE ?').run(pattern).changes;
  }

  let usersDeleted = 0;
  for (const pattern of TEST_USER_PATTERNS) {
    usersDeleted += db.prepare('DELETE FROM users WHERE username LIKE ?').run(pattern).changes;
  }

  return { usersDeleted, postsDeleted };
});

const result = cleanup();

console.log('[cleanup:test-data] Patterns:');
console.log(`  users: ${TEST_USER_PATTERNS.join(', ')}`);
console.log(`  posts: ${TEST_POST_PATTERNS.join(', ')}`);
console.log('[cleanup:test-data] Removed:');
console.log(`  users deleted: ${result.usersDeleted}`);
console.log(`  posts deleted directly: ${result.postsDeleted}`);
console.log(`  total matching posts removed including user cascades: ${testPosts.length}`);
console.log(`  reports deleted via cascade: ${reportsDeleted}`);
