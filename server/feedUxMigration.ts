import type Database from 'better-sqlite3';
import { applyMigration } from './migrations.js';

export const FEED_UX_MIGRATION_ID = 'external-content-feed-ux-v1';

/** Adds the default-on personal-feed video preference without changing subscriptions. */
export function migrateFeedUxPreferences(db: Database.Database): void {
  applyMigration(db, FEED_UX_MIGRATION_ID, () => {
    const columns = db.pragma('table_info(users)') as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'show_videos_in_feed')) {
      db.exec(`
        ALTER TABLE users ADD COLUMN show_videos_in_feed INTEGER NOT NULL DEFAULT 1
          CHECK(show_videos_in_feed IN (0, 1))
      `);
    }
  });
}
