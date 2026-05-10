import 'dotenv/config';
import { initializeDatabase } from './database.js';
import { fetchAllSources, getSources, getWorldFeed } from './rssService.js';

console.log('[rss:fetch] Initializing database...');
initializeDatabase();

const sources = getSources();
const active = sources.filter(s => s.is_active);
console.log(`[rss:fetch] ${active.length}/${sources.length} active sources. Fetching...\n`);

(async () => {
  const results = await fetchAllSources();
  let totalNew = 0, totalDupes = 0;
  for (const r of results) {
    const status = r.error ? '❌' : '✅';
    totalNew += r.itemsInserted;
    totalDupes += r.duplicatesSkipped;
    console.log(`${status} ${r.sourceName.padEnd(25)} | found:${String(r.itemsFound).padStart(4)}  new:${String(r.itemsInserted).padStart(4)}  dupes:${String(r.duplicatesSkipped).padStart(4)}${r.error ? '  ERR: ' + r.error : ''}`);
  }
  console.log(`\nDone: ${totalNew} new items, ${totalDupes} duplicates skipped.`);

  const feed = getWorldFeed({ limit: 1 });
  console.log(`World Feed now has items: ${feed.length > 0 ? 'yes' : 'no'}`);
  process.exit(0);
})();
