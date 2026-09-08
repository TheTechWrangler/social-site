import 'dotenv/config';
import { assertSafeMaintenanceTarget } from './config.js';

try {
  assertSafeMaintenanceTarget('inspect RSS development data');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { initializeDatabase, getDb } = await import('./database.js');
const { getSources } = await import('./rssService.js');

console.log('[rss:status]');
initializeDatabase();
const db = getDb();

const sources = getSources();
const active = sources.filter(s => s.is_active);
const itemCount = (db.prepare('SELECT COUNT(*) as c FROM rss_items').get() as any).c;
const latest = db.prepare('SELECT published_at, title FROM rss_items ORDER BY published_at DESC LIMIT 1').get() as any;
const nullFetch = sources.filter(s => !s.last_fetched_at);

console.log(`  RSS sources:     ${sources.length} (${active.length} active)`);
const podcastCount = (db.prepare("SELECT COUNT(*) as c FROM rss_items WHERE item_type = 'podcast'").get() as any).c; const articleCount = (db.prepare("SELECT COUNT(*) as c FROM rss_items WHERE item_type = 'article'").get() as any).c; console.log(`  RSS items:       ${itemCount} (${articleCount} articles, ${podcastCount} podcasts)`);
console.log(`  Latest item:     ${latest ? latest.published_at + ' — ' + (latest.title || '').slice(0, 60) : 'none'}`);
console.log(`  Never fetched:   ${nullFetch.length} sources`);
if (nullFetch.length > 0) nullFetch.forEach(s => console.log(`    - ${s.name}`));

if (sources.length > 0 && itemCount === 0) {
  console.log(`\n  ⚠ No RSS items fetched yet. Run: npm run rss:fetch`);
}

process.exit(0);
