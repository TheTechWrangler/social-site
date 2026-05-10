import 'dotenv/config';
import { initializeDatabase, getDb } from './database.js';
import { getSources } from './rssService.js';

console.log('[rss:status]');
initializeDatabase();
const db = getDb();

const sources = getSources();
const active = sources.filter(s => s.is_active);
const itemCount = (db.prepare('SELECT COUNT(*) as c FROM rss_items').get() as any).c;
const latest = db.prepare('SELECT published_at, title FROM rss_items ORDER BY published_at DESC LIMIT 1').get() as any;
const nullFetch = sources.filter(s => !s.last_fetched_at);

console.log(`  RSS sources:     ${sources.length} (${active.length} active)`);
console.log(`  RSS items:       ${itemCount}`);
console.log(`  Latest item:     ${latest ? latest.published_at + ' — ' + (latest.title || '').slice(0, 60) : 'none'}`);
console.log(`  Never fetched:   ${nullFetch.length} sources`);
if (nullFetch.length > 0) nullFetch.forEach(s => console.log(`    - ${s.name}`));

if (sources.length > 0 && itemCount === 0) {
  console.log(`\n  ⚠ No RSS items fetched yet. Run: npm run rss:fetch`);
}

process.exit(0);
