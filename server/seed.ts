import 'dotenv/config';
import { initializeDatabase, getDb } from './database.js';
import { hashPassword } from './auth.js';

console.log('[seed] Initializing database...');
initializeDatabase();

const db = getDb();

// Clear existing data if empty (safe: only seeds if no users)
const existingUsers = db.prepare('SELECT COUNT(*) as c FROM users').get() as any;
if (existingUsers.c > 1) {
  console.log(`[seed] Database has ${existingUsers.c} users. Skipping seed (add --reset to force).`);
  process.exit(0);
}

// Reset if --reset flag
if (process.argv.includes('--reset')) {
  console.log('[seed] Resetting database...');
  db.exec('DELETE FROM rss_items');
  db.exec('DELETE FROM rss_sources');
  db.exec('DELETE FROM notifications');
  db.exec('DELETE FROM reports');
  db.exec('DELETE FROM likes');
  db.exec('DELETE FROM posts');
  db.exec('DELETE FROM group_members');
  db.exec('DELETE FROM groups_table');
  db.exec('DELETE FROM follows');
  db.exec('DELETE FROM user_auth_providers');
  db.exec('DELETE FROM users');
}

// ─── Demo Users ───
const users = [
  { username: 'alice', display_name: 'Alice Chen', email: 'alice@demo.local', password: hashPassword('demo1234') },
  { username: 'bob', display_name: 'Bob Rivera', email: 'bob@demo.local', password: hashPassword('demo1234') },
  { username: 'carol', display_name: 'Carol Smith', email: 'carol@demo.local', password: hashPassword('demo1234') },
  { username: 'dave', display_name: 'Dave Kim', email: 'dave@demo.local', password: hashPassword('demo1234') },
  { username: 'eve', display_name: 'Eve Johnson', email: 'eve@demo.local', password: hashPassword('demo1234') },
  { username: 'admin', display_name: 'Admin', email: 'admin@demo.local', password: hashPassword('admin1234') },
];

const insertUser = db.prepare(
  'INSERT OR IGNORE INTO users (username, display_name, email, password_hash, role) VALUES (?, ?, ?, ?, ?)'
);

for (const u of users) {
  const role = u.username === 'admin' ? 'admin' : 'user';
  insertUser.run(u.username, u.display_name, u.email, u.password, role);
}
// Set admin role
db.prepare("UPDATE users SET role = 'admin' WHERE username = 'admin'").run();

console.log(`[seed] Created ${users.length} users`);

// ─── Follows ───
const follows = [[1,2],[1,3],[2,1],[2,4],[3,1],[3,5],[4,2],[5,3],[1,6],[2,6],[3,6]];
const insertFollow = db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)');
for (const [a, b] of follows) insertFollow.run(a, b);
console.log(`[seed] Created ${follows.length} follows`);

// ─── Groups ───
const groups = [
  { name: 'Tech Talk', description: 'Discussing technology, programming, and the future.', owner_id: 1 },
  { name: 'Book Club', description: 'What are you reading? Share recommendations.', owner_id: 3 },
];
const insertGroup = db.prepare('INSERT INTO groups_table (name, description, owner_id) VALUES (?, ?, ?)');
const insertMember = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
for (const g of groups) {
  const r = insertGroup.run(g.name, g.description, g.owner_id);
  const gid = r.lastInsertRowid as number;
  insertMember.run(gid, g.owner_id);
  // Add a couple other members
  insertMember.run(gid, 2);
  insertMember.run(gid, 3);
}
console.log(`[seed] Created ${groups.length} groups`);

// ─── Posts ───
const posts = [
  { user_id: 1, content: 'Just finished setting up my new development environment. VS Code + WSL is a game changer!' },
  { user_id: 2, content: 'Anyone have recommendations for good sci-fi books? Looking for something new to read.' },
  { user_id: 3, content: 'Beautiful sunrise this morning. The sky was absolutely on fire with color.' },
  { user_id: 4, content: 'Working on a new open source project. Hoping to release the first version this weekend.' },
  { user_id: 5, content: 'Just adopted a rescue dog! Meet Max 🐕' },
  { user_id: 1, content: 'The new React 19 features are really impressive. Server components change everything.' },
  { user_id: 6, content: 'Welcome to Social Site! This is a demo post from the admin account. No ads, no algorithms, just people.' },
];
const insertPost = db.prepare('INSERT INTO posts (user_id, content, created_at) VALUES (?, ?, datetime(\'now\', ?))');
for (let i = 0; i < posts.length; i++) {
  const p = posts[i];
  insertPost.run(p.user_id, p.content, `-${(posts.length - i) * 30} minutes`);
}
console.log(`[seed] Created ${posts.length} posts`);

// ─── Likes ───
const likes = [[1,1],[2,1],[3,1],[2,2],[4,2],[1,3],[2,3],[5,3],[3,4],[1,5],[4,5],[2,6]];
const insertLike = db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)');
for (const [u, p] of likes) insertLike.run(u, p);
console.log(`[seed] Created ${likes.length} likes`);

// ─── Comments ───
const comments = [
  { user_id: 2, parent_id: 1, content: 'WSL is amazing! Which distro are you using?' },
  { user_id: 1, parent_id: 2, content: 'Check out The Expanse series if you haven\'t already!' },
  { user_id: 4, parent_id: 2, content: 'I second The Expanse. Also Project Hail Mary.' },
  { user_id: 5, parent_id: 3, content: 'That sounds gorgeous! Would love to see a photo.' },
];
const insertComment = db.prepare('INSERT INTO posts (user_id, content, parent_id, created_at) VALUES (?, ?, ?, datetime(\'now\', ?))');
for (let i = 0; i < comments.length; i++) {
  const c = comments[i];
  insertComment.run(c.user_id, c.content, c.parent_id, `-${(comments.length - i) * 10} minutes`);
}
console.log(`[seed] Created ${comments.length} comments`);

// ─── Notifications ───
const notifs = [
  { user_id: 1, actor_id: 2, type: 'follow' },
  { user_id: 1, actor_id: 3, type: 'follow' },
  { user_id: 2, actor_id: 1, type: 'follow' },
  { user_id: 1, actor_id: 2, type: 'like', post_id: 1 },
  { user_id: 2, actor_id: 1, type: 'comment', post_id: 2 },
];
const insertNotif = db.prepare('INSERT INTO notifications (user_id, actor_id, type, post_id) VALUES (?, ?, ?, ?)');
for (const n of notifs) insertNotif.run(n.user_id, n.actor_id, n.type, n.post_id || null);
console.log(`[seed] Created ${notifs.length} notifications`);

// ─── RSS Sources ───
const rssSources = [
  // Tech / Science
  { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index', homepage_url: 'https://arstechnica.com', category: 'Tech' },
  { name: 'NASA Breaking News', url: 'https://www.nasa.gov/news-release/feed/', homepage_url: 'https://www.nasa.gov', category: 'Science' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', homepage_url: 'https://www.theverge.com', category: 'Tech' },
  { name: 'Hacker News', url: 'https://hnrss.org/frontpage', homepage_url: 'https://news.ycombinator.com', category: 'Tech' },

  // Tech — AI & Hardware
  { name: 'NVIDIA Blog', url: 'https://blogs.nvidia.com/feed/', homepage_url: 'https://blogs.nvidia.com', category: 'Tech / AI' },
  { name: 'GitHub Blog', url: 'https://github.blog/feed/', homepage_url: 'https://github.blog', category: 'Tech' },
  { name: 'Mozilla Blog', url: 'https://blog.mozilla.org/feed/', homepage_url: 'https://blog.mozilla.org', category: 'Tech' },
  { name: 'Raspberry Pi', url: 'https://www.raspberrypi.com/news/feed/', homepage_url: 'https://www.raspberrypi.com', category: 'Tech / Hardware' },

  // Gaming — News & Reviews
  { name: 'IGN', url: 'https://feeds.feedburner.com/ign/all', homepage_url: 'https://www.ign.com', category: 'Gaming' },
  { name: 'GameSpot', url: 'https://www.gamespot.com/feeds/news/', homepage_url: 'https://www.gamespot.com', category: 'Gaming' },
  { name: 'Polygon', url: 'https://www.polygon.com/rss/index.xml', homepage_url: 'https://www.polygon.com', category: 'Gaming' },
  { name: 'Kotaku', url: 'https://kotaku.com/rss', homepage_url: 'https://kotaku.com', category: 'Gaming' },
  { name: 'Destructoid', url: 'https://www.destructoid.com/feed/', homepage_url: 'https://www.destructoid.com', category: 'Gaming' },
  { name: 'Ars Technica Gaming', url: 'https://feeds.arstechnica.com/arstechnica/gaming', homepage_url: 'https://arstechnica.com/gaming', category: 'Gaming' },

  // Gaming — PC
  { name: 'PC Gamer', url: 'https://www.pcgamer.com/rss/', homepage_url: 'https://www.pcgamer.com', category: 'Gaming / PC' },
  { name: 'Rock Paper Shotgun', url: 'https://www.rockpapershotgun.com/feed', homepage_url: 'https://www.rockpapershotgun.com', category: 'Gaming / PC' },

  // Gaming — Console & Platform
  { name: 'Nintendo Life', url: 'https://www.nintendolife.com/feeds/latest', homepage_url: 'https://www.nintendolife.com', category: 'Gaming / Console' },
  { name: 'Xbox Wire', url: 'https://news.xbox.com/en-us/feed/', homepage_url: 'https://news.xbox.com', category: 'Gaming / Platform' },
  { name: 'PlayStation Blog', url: 'https://blog.playstation.com/feed/', homepage_url: 'https://blog.playstation.com', category: 'Gaming / Platform' },
  { name: 'Steam Blog', url: 'https://store.steampowered.com/feeds/news.xml', homepage_url: 'https://store.steampowered.com', category: 'Gaming / Platform' },

  // Gaming — Industry & Culture
  { name: 'Eurogamer', url: 'https://www.eurogamer.net/feed', homepage_url: 'https://www.eurogamer.net', category: 'Gaming' },
  { name: 'GamesIndustry.biz', url: 'https://www.gamesindustry.biz/feed', homepage_url: 'https://www.gamesindustry.biz', category: 'Gaming / Industry' },
];

const insertRss = db.prepare('INSERT OR IGNORE INTO rss_sources (name, url, homepage_url, category) VALUES (?, ?, ?, ?)');
for (const s of rssSources) {
  try {
    insertRss.run(s.name, s.url, s.homepage_url, s.category);
    console.log(`[seed] Added RSS source: ${s.name}`);
  } catch (e: any) {
    console.log(`[seed] Skipped RSS source ${s.name}: ${e.message}`);
  }
}

console.log('\n[seed] Done! Demo accounts:');
console.log('  alice / demo1234');
console.log('  bob   / demo1234');
console.log('  admin / admin1234');
console.log('\n  Start with: npm run dev');
