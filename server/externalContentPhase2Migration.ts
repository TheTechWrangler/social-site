import type Database from 'better-sqlite3';
import { applyMigration } from './migrations.js';

export const EXTERNAL_CONTENT_PHASE2_MIGRATION_ID = 'external-content-youtube-submissions-v2';

/** Adds review-only user source suggestions. Existing external-content tables are unchanged. */
export function migrateExternalContentPhase2(db: Database.Database): void {
  applyMigration(db, EXTERNAL_CONTENT_PHASE2_MIGRATION_ID, () => {
    const unexpected = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'external_source_submissions'
    `).get();
    if (unexpected) {
      throw new Error('External content Phase 2 migration blocked: submissions table exists without a ledger entry.');
    }

    db.exec(`
      CREATE TABLE external_source_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submitted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        proposed_kind TEXT NOT NULL CHECK(proposed_kind IN ('rss', 'youtube_channel')),
        proposed_locator TEXT NOT NULL CHECK(length(proposed_locator) BETWEEN 1 AND 2048),
        proposed_name TEXT NOT NULL DEFAULT '' CHECK(length(proposed_name) <= 120),
        proposed_category TEXT NOT NULL DEFAULT 'general' CHECK(length(proposed_category) BETWEEN 1 AND 80),
        note TEXT NOT NULL DEFAULT '' CHECK(length(note) <= 500),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
        reviewed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        reviewed_at TEXT,
        resulting_source_id INTEGER REFERENCES external_sources(id) ON DELETE SET NULL,
        review_note TEXT NOT NULL DEFAULT '' CHECK(length(review_note) <= 500),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK(
          (status = 'pending' AND reviewed_at IS NULL AND resulting_source_id IS NULL)
          OR (status = 'approved' AND reviewed_at IS NOT NULL AND resulting_source_id IS NOT NULL)
          OR (status = 'rejected' AND reviewed_at IS NOT NULL AND resulting_source_id IS NULL)
        )
      );

      CREATE INDEX idx_external_source_submissions_status
        ON external_source_submissions(status, created_at, id);
      CREATE INDEX idx_external_source_submissions_submitter
        ON external_source_submissions(submitted_by_user_id, created_at DESC, id DESC);
      CREATE INDEX idx_external_source_submissions_result
        ON external_source_submissions(resulting_source_id)
        WHERE resulting_source_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_external_source_submissions_pending_unique
        ON external_source_submissions(submitted_by_user_id, proposed_kind, proposed_locator)
        WHERE status = 'pending' AND submitted_by_user_id IS NOT NULL;
    `);

    const violations = db.pragma('foreign_key_check(external_source_submissions)') as unknown[];
    if (violations.length) throw new Error('External content Phase 2 migration failed foreign-key validation.');
  });
}
