import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { assertNoSymlinks } from './storageSafety.js';
import { fileEvidence } from './recovery.js';
import { auditOperation } from './operationalAudit.js';

export const PENDING_ASSET_TTL_MS = 60 * 60 * 1000;
export const DETACHED_ASSET_GRACE_MS = 24 * 60 * 60 * 1000;
export const MANAGED_STORAGE_KEY = /^asset-[a-f0-9]{32}\.(?:jpe?g|png|gif|webp)$/;
export interface ReclamationOptions {
  uploadsDir: string; nodeEnv: string; nowMs?: number; limit?: number;
  allowPhysicalDeletion?: boolean; dryRun?: boolean;
  unlinkFile?: (filePath: string) => void;
  beforeCandidate?: (id: string) => void;
}
export interface ReclamationResult {
  disabled: boolean; pendingExpired: number; considered: number; deleted: number; failed: number;
  untrackedConsidered: number; untrackedDeleted: number;
  eligible: number; referenced: number; gracePeriod: number; unsafePath: number; missing: number;
}
interface Asset { id: string; storage_key: string; url: string; state: string; reclaim_after_ms: number | null;
  sha256: string; file_size_bytes: number }

export function reclaimManagedAssets(db: Database.Database, options: ReclamationOptions): ReclamationResult {
  const now = options.nowMs ?? Date.now(), limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid GC bounds');
  const dry = options.dryRun === true;
  // Production remains hard-disabled, irrespective of operator/test options.
  const enabled = ['test', 'development'].includes(options.nodeEnv)
    && (process.env.NODE_ENV || '').trim().toLowerCase() !== 'production'
    && options.allowPhysicalDeletion === true && !dry;
  const result: ReclamationResult = { disabled: !enabled, pendingExpired: 0, considered: 0, deleted: 0,
    failed: 0, untrackedConsidered: 0, untrackedDeleted: 0, eligible: 0, referenced: 0, gracePeriod: 0, unsafePath: 0, missing: 0 };
  if (!dry) result.pendingExpired = db.prepare(`UPDATE managed_assets SET state = 'reclaimable', detached_at_ms = ?, reclaim_after_ms = ?
    WHERE id IN (SELECT id FROM managed_assets WHERE state = 'pending' AND pending_expires_at_ms <= ? ORDER BY pending_expires_at_ms,id LIMIT ?)`)
    .run(now, now + DETACHED_ASSET_GRACE_MS, now, limit).changes;
  if (!enabled && !dry) return result;
  const candidates = db.prepare("SELECT id FROM managed_assets WHERE state = 'reclaimable' ORDER BY reclaim_after_ms,id LIMIT ?").all(limit) as { id: string }[];
  for (const candidate of candidates) {
    options.beforeCandidate?.(candidate.id);
    result.considered++;
    try {
      if (enabled) auditOperation(db, 'asset.delete_attempt', null, 'asset', candidate.id);
      // Acquire SQLite's write reservation before re-reading: another writer cannot
      // attach the asset between validation and unlink. Never trust a queued row.
      db.transaction(() => {
        const asset = db.prepare('SELECT * FROM managed_assets WHERE id = ?').get(candidate.id) as Asset | undefined;
        if (!asset || asset.state !== 'reclaimable') return;
        if (!Number.isSafeInteger(asset.reclaim_after_ms) || asset.reclaim_after_ms! < 0 || asset.reclaim_after_ms! > now) { result.gracePeriod++; return; }
        const referenced = db.prepare(`SELECT 1 FROM post_media WHERE asset_id = ? OR url = ? OR thumbnail_url = ?
          UNION ALL SELECT 1 FROM user_avatar_uploads WHERE asset_id = ? OR url = ?
          UNION ALL SELECT 1 FROM users WHERE avatar_url = ?
          UNION ALL SELECT 1 FROM games WHERE cover_image_url = ? LIMIT 1`)
          .get(asset.id, asset.url, asset.url, asset.id, asset.url, asset.url, asset.url);
        if (referenced) { result.referenced++; throw new Error('referenced'); }
        if (!MANAGED_STORAGE_KEY.test(asset.storage_key) || asset.url !== `/uploads/${asset.storage_key}`) {
          result.unsafePath++; throw new Error('unsafe');
        }
        const filename = path.join(path.resolve(options.uploadsDir), asset.storage_key);
        try { assertNoSymlinks(filename); } catch { result.unsafePath++; throw new Error('unsafe'); }
        let identity: fs.Stats | undefined;
        try {
          identity = fs.lstatSync(filename);
          if (!identity.isFile() || identity.nlink !== 1) { result.unsafePath++; throw new Error('unsafe'); }
          const evidence = fileEvidence(filename);
          if (evidence.bytes !== asset.file_size_bytes || evidence.sha256 !== asset.sha256) throw new Error('identity');
        } catch (error: any) { if (error.code !== 'ENOENT') throw error; result.missing++; }
        result.eligible++;
        if (!enabled) return;
        // Audit before unlink; failure must never cause unaudited physical deletion.
        if (identity) {
          const current = fs.lstatSync(filename);
          if (current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev
            || current.mtimeMs !== identity.mtimeMs || current.ctimeMs !== identity.ctimeMs) throw new Error('identity');
          (options.unlinkFile ?? fs.unlinkSync)(filename);
        }
        db.prepare(`UPDATE managed_assets SET state = 'deleted', deleted_at_ms = ?, reclaim_attempts = reclaim_attempts + 1,
          last_reclaim_error = '' WHERE id = ? AND state = 'reclaimable'`).run(now, asset.id);
        auditOperation(db, 'asset.deleted', null, 'asset', asset.id);
      }).immediate();
      if (enabled && (db.prepare('SELECT state FROM managed_assets WHERE id = ?').get(candidate.id) as any)?.state === 'deleted') result.deleted++;
    } catch (error) {
      result.failed++;
      if (enabled) {
        // Fixed non-sensitive diagnostic, retry on the next bounded operator run.
        try { db.prepare(`UPDATE managed_assets SET reclaim_attempts = reclaim_attempts + 1,
          last_reclaim_error = 'Reclamation refused or incomplete; revalidate before retry' WHERE id = ? AND state = 'reclaimable'`).run(candidate.id); }
        catch { /* DB unavailable: leave reclaimable; missing-file retry converges. */ }
      }
    }
  }
  // No name/age-based deletion of unknown files. Legacy disk leakage is safer.
  return result;
}

export function listUntrackedManagedFiles(db: Database.Database, uploadsDir: string): string[] {
  assertNoSymlinks(uploadsDir);
  const output: string[] = [];
  const tracked = db.prepare('SELECT 1 FROM managed_assets WHERE storage_key = ?');
  const directory = fs.opendirSync(uploadsDir);
  try {
    let entry: fs.Dirent | null, examined = 0;
    while ((entry = directory.readSync()) && examined++ < 5000) {
      if (entry.isFile() && MANAGED_STORAGE_KEY.test(entry.name) && !tracked.get(entry.name)) output.push(entry.name);
    }
  } finally { directory.closeSync(); }
  return output.sort();
}
