import 'dotenv/config';
import { assertSafeMaintenanceTarget } from './config.js';

const resetRequested = process.argv.includes('--reset');
try {
  assertSafeMaintenanceTarget('seed development data', {
    confirmationFlag: resetRequested ? '--confirm-dev-reset' : undefined,
  });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { initializeDatabase, getDb } = await import('./database.js');
const { hashPassword } = await import('./auth.js');
const { fetchSource } = await import('./rssService.js');
console.log('[seed] Initializing database...');
initializeDatabase();

const db = getDb();

// Reset first (before the skip-if-exists check, so --reset actually works)
if (resetRequested) {
  console.log('[seed] Resetting database...');
  db.exec('DELETE FROM rss_item_comments');
  db.exec('DELETE FROM user_rss_source_blocks');
  db.exec('DELETE FROM rss_items');
  db.exec('DELETE FROM rss_sources');
  db.exec('DELETE FROM game_lfg_posts');
  db.exec('DELETE FROM user_game_preferences');
  db.exec('DELETE FROM user_relationship_blocks');
  db.exec('DELETE FROM notifications');
  // reports.resolved_by has no CASCADE — null it before deleting users/reports
  db.exec('UPDATE reports SET resolved_by = NULL');
  db.exec('DELETE FROM reports');
  db.exec('DELETE FROM likes');
  db.exec('DELETE FROM post_media');
  db.exec('DELETE FROM posts');
  db.exec('DELETE FROM group_members');
  db.exec('DELETE FROM groups_table');
  db.exec('DELETE FROM follows');
  db.exec('DELETE FROM user_auth_providers');
  db.exec('DELETE FROM users');
  // Reset auto-increment counters so IDs start from 1 again
  db.exec("DELETE FROM sqlite_sequence");
}

// Skip if already seeded (and not resetting)
const existingUsers = db.prepare('SELECT COUNT(*) as c FROM users').get() as any;
if (existingUsers.c > 1) {
  console.log(`[seed] Database has ${existingUsers.c} users. Skipping seed (add --reset to force).`);
  process.exit(0);
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
// Set admin role and verify all demo users
db.prepare("UPDATE users SET role = 'admin' WHERE username = 'admin'").run();
db.prepare("UPDATE users SET is_verified = 1, profile_visibility = 'public', feed_exposure = 'extended'").run();

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
  { user_id: 6, content: 'Welcome to Refuge Cloud! This is a demo post from the admin account. No ads, no algorithms, just people.' },
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

  // Podcasts
  { name: 'The Changelog', url: 'https://changelog.com/podcast/feed', homepage_url: 'https://changelog.com', category: 'Podcasts / Tech' },
  { name: 'Software Engineering Daily', url: 'https://softwareengineeringdaily.com/feed/podcast/', homepage_url: 'https://softwareengineeringdaily.com', category: 'Podcasts / Tech' },
  { name: 'Linux Unplugged', url: 'https://feeds.fireside.fm/linuxunplugged/rss', homepage_url: 'https://www.jupiterbroadcasting.com/show/linux-unplugged/', category: 'Podcasts / Tech' },

  // General News
  { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml', homepage_url: 'https://www.npr.org', category: 'News' },
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', homepage_url: 'https://www.bbc.com/news/world', category: 'News' },
  { name: 'Reuters Top News', url: 'https://feeds.reuters.com/reuters/topNews', homepage_url: 'https://www.reuters.com', category: 'News' },
  { name: 'AP News', url: 'https://rsshub.app/apnews/topics/apf-topnews', homepage_url: 'https://apnews.com', category: 'News' },

  // Science & Space
  { name: 'New Scientist', url: 'https://www.newscientist.com/feed/home/', homepage_url: 'https://www.newscientist.com', category: 'Science' },
  { name: 'Space.com', url: 'https://www.space.com/feeds/all', homepage_url: 'https://www.space.com', category: 'Science' },
  { name: 'Phys.org', url: 'https://phys.org/rss-feed/', homepage_url: 'https://phys.org', category: 'Science' },

  // Open Source & Developer Culture
  { name: 'LWN.net', url: 'https://lwn.net/headlines/rss', homepage_url: 'https://lwn.net', category: 'Open Source' },
  { name: 'OSNews', url: 'https://www.osnews.com/feed/', homepage_url: 'https://www.osnews.com', category: 'Open Source' },
  { name: 'Opensource.com', url: 'https://opensource.com/feed', homepage_url: 'https://opensource.com', category: 'Open Source' },

  // Creative & Design
  { name: 'Smashing Magazine', url: 'https://www.smashingmagazine.com/feed/', homepage_url: 'https://www.smashingmagazine.com', category: 'Design / Dev' },
  { name: 'CSS-Tricks', url: 'https://css-tricks.com/feed/', homepage_url: 'https://css-tricks.com', category: 'Design / Dev' },

  // Podcasts — General / Culture
  { name: '99% Invisible', url: 'https://feeds.simplecast.com/BqbsxVfO', homepage_url: 'https://99percentinvisible.org', category: 'Podcasts / Culture' },
  { name: 'Radiolab', url: 'https://feeds.feedburner.com/radiolab', homepage_url: 'https://www.wnycstudios.org/podcasts/radiolab', category: 'Podcasts / Culture' },
  { name: 'Darknet Diaries', url: 'https://feeds.megaphone.fm/darknetdiaries', homepage_url: 'https://darknetdiaries.com', category: 'Podcasts / Tech' },
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

// ─── Games ───
const seedGames = [
  { name: '7 Days to Die', slug: '7-days-to-die', platforms: 'PC, Xbox, PS5', description: 'Open-world zombie survival crafting game.' },
  { name: 'Among Us', slug: 'among-us', platforms: 'PC, Mobile, Switch', description: 'Social deduction party game.' },
  { name: 'Apex Legends', slug: 'apex-legends', platforms: 'PC, Xbox, PS5, Switch', description: 'Free-to-play hero battle royale.' },
  { name: 'Ark: Survival Ascended', slug: 'ark-survival-ascended', platforms: 'PC, Xbox, PS5', description: 'Unreal Engine 5 remake of the dinosaur survival game.' },
  { name: 'Baldur\'s Gate 3', slug: 'baldurs-gate-3', platforms: 'PC, Xbox, PS5', description: 'Dungeons & Dragons RPG from Larian Studios.' },
  { name: 'Call of Duty', slug: 'call-of-duty', platforms: 'PC, Xbox, PS5', description: 'Fast-paced military shooter franchise with multiplayer and Warzone.' },
  { name: 'Civilization VI', slug: 'civilization-vi', platforms: 'PC, Xbox, PS5, Switch', description: 'Turn-based strategy. Build an empire to stand the test of time.' },
  { name: 'Counter-Strike 2', slug: 'counter-strike-2', platforms: 'PC', description: 'Tactical FPS. The classic competitive shooter.' },
  { name: 'DayZ', slug: 'dayz', platforms: 'PC, Xbox, PS5', description: 'Hardcore open-world survival in post-soviet Chernarus.' },
  { name: 'Dead by Daylight', slug: 'dead-by-daylight', platforms: 'PC, Xbox, PS5, Switch', description: 'Asymmetric 4v1 horror survival game.' },
  { name: 'Destiny 2', slug: 'destiny-2', platforms: 'PC, Xbox, PS5', description: 'Free-to-play sci-fi MMO looter shooter.' },
  { name: 'Diablo IV', slug: 'diablo-iv', platforms: 'PC, Xbox, PS5', description: 'Action RPG. Fight the forces of Hell in Sanctuary.' },
  { name: 'Dota 2', slug: 'dota-2', platforms: 'PC', description: 'Free-to-play MOBA. Two teams of five battle to destroy the enemy Ancient.' },
  { name: 'Elden Ring', slug: 'elden-ring', platforms: 'PC, Xbox, PS5', description: 'Open-world action RPG from FromSoftware and George R.R. Martin.' },
  { name: 'Escape from Tarkov', slug: 'escape-from-tarkov', platforms: 'PC', description: 'Hardcore tactical FPS with RPG and survival elements.' },
  { name: 'Factorio', slug: 'factorio', platforms: 'PC', description: 'Build and automate factories on an alien planet.' },
  { name: 'Final Fantasy XIV', slug: 'final-fantasy-xiv', platforms: 'PC, Xbox, PS5', description: 'Critically acclaimed MMORPG with a rich story.' },
  { name: 'Fortnite', slug: 'fortnite', platforms: 'PC, Xbox, PS5, Switch, Mobile', description: 'Battle royale, creative mode, and live events.' },
  { name: 'Garry\'s Mod', slug: 'garrys-mod', platforms: 'PC', description: 'Physics sandbox. Create, build, and roleplay.' },
  { name: 'Grand Theft Auto Online', slug: 'gta-online', platforms: 'PC, Xbox, PS5', description: 'Open-world criminal empire multiplayer.' },
  { name: 'Guild Wars 2', slug: 'guild-wars-2', platforms: 'PC', description: 'Free-to-play MMORPG with dynamic events.' },
  { name: 'Helldivers 2', slug: 'helldivers-2', platforms: 'PC, PS5', description: 'Cooperative third-person shooter for intergalactic democracy.' },
  { name: 'Hunt: Showdown', slug: 'hunt-showdown', platforms: 'PC, Xbox, PS5', description: 'PvPvE bounty hunting in 1895 Louisiana bayou.' },
  { name: 'League of Legends', slug: 'league-of-legends', platforms: 'PC', description: 'The world\'s most popular MOBA.' },
  { name: 'Lethal Company', slug: 'lethal-company', platforms: 'PC', description: 'Co-op horror scavenging game. Collect scrap on abandoned moons.' },
  { name: 'Minecraft', slug: 'minecraft', platforms: 'PC, Xbox, PS5, Switch, Mobile', description: 'The sandbox building game with infinite possibilities.' },
  { name: 'Monster Hunter', slug: 'monster-hunter', platforms: 'PC, Xbox, PS5', description: 'Hunt massive monsters in beautiful ecosystems.' },
  { name: 'No Man\'s Sky', slug: 'no-mans-sky', platforms: 'PC, Xbox, PS5, Switch', description: 'Infinite procedurally generated universe to explore.' },
  { name: 'Overwatch 2', slug: 'overwatch-2', platforms: 'PC, Xbox, PS5, Switch', description: 'Free-to-play team-based hero shooter.' },
  { name: 'Palworld', slug: 'palworld', platforms: 'PC, Xbox', description: 'Open-world creature collection and survival with guns.' },
  { name: 'Path of Exile', slug: 'path-of-exile', platforms: 'PC, Xbox, PS5', description: 'Free-to-play action RPG with deep character customization.' },
  { name: 'Phasmophobia', slug: 'phasmophobia', platforms: 'PC', description: '4-player co-op ghost hunting horror game.' },
  { name: 'Project Zomboid', slug: 'project-zomboid', platforms: 'PC', description: 'Hardcore isometric zombie survival RPG.' },
  { name: 'PUBG: Battlegrounds', slug: 'pubg', platforms: 'PC, Xbox, PS5', description: 'The original battle royale. 100 players, last one standing wins.' },
  { name: 'Rainbow Six Siege', slug: 'rainbow-six-siege', platforms: 'PC, Xbox, PS5', description: 'Tactical 5v5 shooter with destructible environments.' },
  { name: 'Red Dead Online', slug: 'red-dead-online', platforms: 'PC, Xbox, PS5', description: 'Online western frontier multiplayer.' },
  { name: 'RimWorld', slug: 'rimworld', platforms: 'PC', description: 'Sci-fi colony management story generator.' },
  { name: 'Roblox', slug: 'roblox', platforms: 'PC, Xbox, Mobile', description: 'User-generated game platform with millions of experiences.' },
  { name: 'Rocket League', slug: 'rocket-league', platforms: 'PC, Xbox, PS5, Switch', description: 'Free-to-play soccer with rocket-powered cars.' },
  { name: 'Rust', slug: 'rust', platforms: 'PC, Xbox, PS5', description: 'Brutal multiplayer survival game. Build, raid, survive.' },
  { name: 'Satisfactory', slug: 'satisfactory', platforms: 'PC', description: 'First-person open-world factory building game.' },
  { name: 'Sea of Thieves', slug: 'sea-of-thieves', platforms: 'PC, Xbox, PS5', description: 'Pirate adventure. Sail, fight, and plunder with your crew.' },
  { name: 'Stardew Valley', slug: 'stardew-valley', platforms: 'PC, Xbox, PS5, Switch, Mobile', description: 'Farming life RPG. Build your dream farm.' },
  { name: 'Stellaris', slug: 'stellaris', platforms: 'PC, Xbox, PS5', description: 'Grand strategy. Explore the galaxy and build a stellar empire.' },
  { name: 'Tabletop / D&D', slug: 'tabletop-dnd', platforms: 'Any', description: 'Dungeons & Dragons and tabletop roleplaying games.' },
  { name: 'Team Fortress 2', slug: 'team-fortress-2', platforms: 'PC', description: 'Free-to-play class-based team shooter.' },
  { name: 'Terraria', slug: 'terraria', platforms: 'PC, Xbox, PS5, Switch, Mobile', description: '2D sandbox adventure. Dig, fight, explore, build.' },
  { name: 'The Elder Scrolls Online', slug: 'elder-scrolls-online', platforms: 'PC, Xbox, PS5', description: 'MMORPG set in the world of Tamriel.' },
  { name: 'Valheim', slug: 'valheim', platforms: 'PC, Xbox', description: 'Viking survival and exploration in a procedurally generated world.' },
  { name: 'Valorant', slug: 'valorant', platforms: 'PC', description: 'Free-to-play tactical shooter with unique agent abilities.' },
  { name: 'VRChat', slug: 'vrchat', platforms: 'PC, VR', description: 'Social VR platform. Explore worlds and meet people.' },
  { name: 'Warframe', slug: 'warframe', platforms: 'PC, Xbox, PS5, Switch', description: 'Free-to-play sci-fi action game. Space ninjas with guns.' },
  { name: 'World of Warcraft', slug: 'world-of-warcraft', platforms: 'PC', description: 'The legendary MMORPG. For the Horde! For the Alliance!' },
  { name: 'iRacing', slug: 'iracing', platforms: 'PC', description: 'Professional online racing simulation.' },
  { name: 'Forza Horizon', slug: 'forza-horizon', platforms: 'PC, Xbox', description: 'Open-world racing festival with hundreds of cars.' },
  { name: 'EA Sports FC', slug: 'ea-sports-fc', platforms: 'PC, Xbox, PS5, Switch', description: 'The world\'s game. Soccer simulation.' },
  { name: 'Madden NFL', slug: 'madden-nfl', platforms: 'PC, Xbox, PS5', description: 'American football simulation.' },
  { name: 'NBA 2K', slug: 'nba-2k', platforms: 'PC, Xbox, PS5, Switch', description: 'Basketball simulation and MyCareer mode.' },
  { name: 'WWE 2K', slug: 'wwe-2k', platforms: 'PC, Xbox, PS5', description: 'Professional wrestling simulation.' },
  { name: 'MLB The Show', slug: 'mlb-the-show', platforms: 'Xbox, PS5, Switch', description: 'Baseball simulation.' },
];
const insertGame = db.prepare('INSERT OR IGNORE INTO games (name, slug, platforms, description) VALUES (?, ?, ?, ?)');
for (const g of seedGames) { insertGame.run(g.name, g.slug, g.platforms, g.description); }
console.log(`[seed] Added ${seedGames.length} games`);

// ─── Demo Game Servers ───
const seedServers = [
  { game: '7-days-to-die', name: 'Refuge Gaming PvE', description: 'Community PvE server. Friendly survivors welcome!', connection_host: 'refuge-gaming.example.com', connection_port: 26900, platform: 'PC', status: 'online', max_players: 16, current_players: 8, is_featured: 1, join_instructions: 'Search for "Refuge Gaming PvE" in the server browser or connect directly.', rules_summary: 'No griefing. Be respectful. Have fun.' },
  { game: 'valheim', name: 'Refuge Valheim', description: 'Dedicated Valheim server. Fresh world, all biomes.', connection_host: 'refuge-gaming.example.com', connection_port: 2456, platform: 'PC', status: 'online', max_players: 10, current_players: 4, join_instructions: 'Join via Steam server browser or direct connect.', rules_summary: 'Respect builds. No spawn camping.' },
  { game: 'minecraft', name: 'Craft Refuge', description: 'Vanilla+ Minecraft community server. Java Edition.', connection_host: 'refuge-gaming.example.com', connection_port: 25565, platform: 'PC (Java)', status: 'online', max_players: 30, current_players: 12, is_featured: 1, join_instructions: 'Add server in Multiplayer menu.', rules_summary: 'No griefing. Claim your land. Community builds welcome!' },
];
const insertServer = db.prepare(`INSERT OR IGNORE INTO game_servers (game_id, name, description, connection_host, connection_port, platform, status, max_players, current_players, is_featured, join_instructions, rules_summary)
  VALUES ((SELECT id FROM games WHERE slug = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
for (const s of seedServers) {
  try { insertServer.run(s.game, s.name, s.description, s.connection_host, s.connection_port, s.platform, s.status, s.max_players, s.current_players, s.is_featured || 0, s.join_instructions, s.rules_summary); console.log(`[seed] Added server: ${s.name}`); } catch (e: any) { console.log(`[seed] Server ${s.name}: ${e.message}`); }
}

// ─── Seed RSS items — one source per category for variety ───
const seedRssSources = db.prepare(
  'SELECT MIN(id) as id, MIN(name) as name FROM rss_sources WHERE is_active = 1 GROUP BY category'
).all() as any[];
for (const src of seedRssSources) {
  try {
    const result = await fetchSource(src.id);
    console.log(`[seed] RSS fetch ${src.name}: ${result.itemsInserted} inserted, ${result.duplicatesSkipped} skipped`);
  } catch (e: any) {
    console.log(`[seed] RSS fetch ${src.name} failed: ${e.message}`);
  }
}

console.log('\n[seed] Done! Demo accounts:');
console.log('  alice / demo1234');
console.log('  bob   / demo1234');
console.log('  admin / admin1234');
console.log('\n  Start with: npm run dev');
