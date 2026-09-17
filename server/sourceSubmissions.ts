import type Database from 'better-sqlite3';
import { getDb } from './database.js';
import { auditOperation } from './operationalAudit.js';
import { downloadFeed, parseFeedXml, validateRssUrl, type RssNetworkDependencies } from './rssNetwork.js';
import { persistFetchedFeed, type RssSource } from './rssService.js';
import { createYouTubeSourceFromProbe, probeYouTubeChannel, type YouTubeProbe } from './youtubeService.js';
import { parseYouTubeChannelLocator } from '../shared/youtube.js';

export type SubmissionKind = 'rss' | 'youtube_channel';

export interface SubmissionInput {
  sourceKind: SubmissionKind;
  locator: string;
  name?: string;
  category?: string;
  note?: string;
}

function clean(value: string | undefined, max: number): string {
  const normalized = (value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (normalized.length > max) throw new Error(`Field must be ${max} characters or fewer.`);
  return normalized;
}

export function normalizeSubmissionInput(input: SubmissionInput): Required<SubmissionInput> {
  if (!['rss', 'youtube_channel'].includes(input.sourceKind)) throw new Error('Unsupported source type.');
  let locator = clean(input.locator, 2048);
  if (!locator) throw new Error('A source locator is required.');
  if (input.sourceKind === 'rss') {
    try {
      const url = validateRssUrl(locator);
      url.hash = '';
      locator = url.href;
    } catch {
      throw new Error('Enter a valid HTTP or HTTPS feed URL.');
    }
  } else {
    const channelId = parseYouTubeChannelLocator(locator);
    if (!channelId) throw new Error('Enter a YouTube channel ID or canonical channel URL.');
    locator = channelId;
  }
  return {
    sourceKind: input.sourceKind,
    locator,
    name: clean(input.name, 120),
    category: clean(input.category, 80) || 'general',
    note: clean(input.note, 500),
  };
}

function ownDto(row: any) {
  return {
    id: row.id,
    sourceKind: row.proposed_kind,
    locator: row.proposed_locator,
    name: row.proposed_name,
    category: row.proposed_category,
    note: row.note,
    status: row.status,
    resultingSourceId: row.public_result_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function adminDto(row: any) {
  return {
    ...ownDto({ ...row, public_result_id: row.resulting_source_id }),
    submittedBy: row.submitted_by_user_id === null ? null : {
      id: row.submitted_by_user_id,
      username: row.submitter_username,
    },
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
  };
}

export function createSourceSubmission(userId: number, raw: SubmissionInput) {
  const input = normalizeSubmissionInput(raw);
  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO external_source_submissions (
        submitted_by_user_id, proposed_kind, proposed_locator, proposed_name, proposed_category, note
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, input.sourceKind, input.locator, input.name, input.category, input.note);
    return { submission: ownDto(db.prepare(`
      SELECT *, NULL AS public_result_id FROM external_source_submissions WHERE id=?
    `).get(result.lastInsertRowid)), created: true };
  } catch (error: any) {
    if (!String(error?.code).startsWith('SQLITE_CONSTRAINT')) throw error;
    const existing = db.prepare(`
      SELECT *, NULL AS public_result_id FROM external_source_submissions
      WHERE submitted_by_user_id=? AND proposed_kind=? AND proposed_locator=? AND status='pending'
    `).get(userId, input.sourceKind, input.locator);
    if (!existing) throw error;
    return { submission: ownDto(existing), created: false };
  }
}

export function getOwnSourceSubmissions(userId: number) {
  return (getDb().prepare(`
    SELECT sub.*,
      CASE WHEN source.id IS NOT NULL AND source.is_active=1 AND source.tombstoned_at IS NULL
        THEN source.id ELSE NULL END AS public_result_id
    FROM external_source_submissions sub
    LEFT JOIN external_sources source ON source.id=sub.resulting_source_id
    WHERE sub.submitted_by_user_id=?
    ORDER BY sub.created_at DESC, sub.id DESC LIMIT 100
  `).all(userId) as any[]).map(ownDto);
}

export function getAdminSourceSubmissions(status?: 'pending' | 'approved' | 'rejected') {
  const where = status ? 'WHERE sub.status=?' : '';
  const values = status ? [status] : [];
  return (getDb().prepare(`
    SELECT sub.*, user.username AS submitter_username
    FROM external_source_submissions sub
    LEFT JOIN users user ON user.id=sub.submitted_by_user_id
    ${where}
    ORDER BY CASE sub.status WHEN 'pending' THEN 0 ELSE 1 END, sub.created_at, sub.id LIMIT 500
  `).all(...values) as any[]).map(adminDto);
}

export interface ApprovalDependencies {
  rssNetwork?: RssNetworkDependencies;
  youtubeNetwork?: RssNetworkDependencies;
  probeYoutube?: (locator: string, dependencies?: RssNetworkDependencies) => Promise<YouTubeProbe>;
}

export async function approveSourceSubmission(
  submissionId: number,
  adminId: number,
  dependencies: ApprovalDependencies = {},
) {
  const db = getDb();
  const pending = db.prepare(`SELECT * FROM external_source_submissions WHERE id=? AND status='pending'`)
    .get(submissionId) as any;
  if (!pending) return null;

  // Provider validation deliberately happens only on this authenticated admin path.
  // User submission creation never calls a network, DNS, or provider adapter.
  let rssFeed: any = null;
  let youtubeProbe: YouTubeProbe | null = null;
  if (pending.proposed_kind === 'rss') {
    rssFeed = await parseFeedXml(await downloadFeed(pending.proposed_locator, dependencies.rssNetwork));
  } else if (pending.proposed_kind === 'youtube_channel') {
    youtubeProbe = await (dependencies.probeYoutube ?? probeYouTubeChannel)(pending.proposed_locator, dependencies.youtubeNetwork);
  } else {
    throw new Error('Unsupported submission type.');
  }

  return db.transaction(() => {
    const current = db.prepare(`SELECT * FROM external_source_submissions WHERE id=? AND status='pending'`)
      .get(submissionId) as any;
    if (!current) return null;
    let sourceId: number;
    if (current.proposed_kind === 'rss') {
      const parsedUrl = validateRssUrl(current.proposed_locator);
      const fallbackName = clean(rssFeed?.title, 120) || parsedUrl.hostname.slice(0, 120);
      const result = db.prepare(`
        INSERT INTO external_sources(provider,source_kind,name,fetch_url,homepage_url,category)
        VALUES ('rss','rss',?,?,?,?)
      `).run(current.proposed_name || fallbackName, parsedUrl.href, '', current.proposed_category || 'general');
      sourceId = Number(result.lastInsertRowid);
      const source = db.prepare(`
        SELECT id,name,fetch_url AS url,homepage_url,category,is_active,tombstoned_at,
          last_fetched_at,last_fetch_attempt_at,last_failure_detail AS last_fetch_error,last_failure_code,updated_at
        FROM external_sources WHERE id=?
      `).get(sourceId) as RssSource;
      persistFetchedFeed(db, source, rssFeed);
    } else {
      if (!youtubeProbe) throw new Error('Missing YouTube validation result.');
      sourceId = createYouTubeSourceFromProbe(
        db, youtubeProbe, current.proposed_name, current.proposed_category,
      ).sourceId;
    }
    const update = db.prepare(`
      UPDATE external_source_submissions
      SET status='approved', reviewed_by_user_id=?, reviewed_at=datetime('now'),
        resulting_source_id=?, review_note='', updated_at=datetime('now')
      WHERE id=? AND status='pending'
    `).run(adminId, sourceId, submissionId);
    if (update.changes !== 1) throw new Error('Submission review state changed.');
    auditOperation(db, 'external_source_submission.approve', adminId, 'external_source_submission', submissionId);
    return adminDto(db.prepare(`
      SELECT sub.*, user.username AS submitter_username FROM external_source_submissions sub
      LEFT JOIN users user ON user.id=sub.submitted_by_user_id WHERE sub.id=?
    `).get(submissionId));
  }).immediate();
}

export function rejectSourceSubmission(submissionId: number, adminId: number, reason = '') {
  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare(`
      UPDATE external_source_submissions
      SET status='rejected', reviewed_by_user_id=?, reviewed_at=datetime('now'),
        review_note=?, updated_at=datetime('now')
      WHERE id=? AND status='pending'
    `).run(adminId, clean(reason, 500), submissionId);
    if (result.changes !== 1) return null;
    auditOperation(db, 'external_source_submission.reject', adminId, 'external_source_submission', submissionId);
    return adminDto(db.prepare(`
      SELECT sub.*, user.username AS submitter_username FROM external_source_submissions sub
      LEFT JOIN users user ON user.id=sub.submitted_by_user_id WHERE sub.id=?
    `).get(submissionId));
  }).immediate();
}
