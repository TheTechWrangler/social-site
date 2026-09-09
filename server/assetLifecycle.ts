import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

export const PENDING_ASSET_TTL_MS = 60 * 60 * 1000;
export const DETACHED_ASSET_GRACE_MS = 24 * 60 * 60 * 1000;
export const MANAGED_STORAGE_KEY = /^asset-[a-f0-9]{32}\.(?:jpe?g|png|gif|webp)$/;

export interface ReclamationOptions {
  uploadsDir: string;
  nodeEnv: string;
  nowMs?: number;
  limit?: number;
  allowPhysicalDeletion?: boolean;
  unlinkFile?: (filePath: string) => void;
}

export interface ReclamationResult {
  disabled: boolean;
  pendingExpired: number;
  considered: number;
  deleted: number;
  failed: number;
  untrackedConsidered: number;
  untrackedDeleted: number;
}

function managedFilePath(uploadsDir: string, storageKey: string): string | null {
  if (!MANAGED_STORAGE_KEY.test(storageKey)) return null;
  const root = path.resolve(uploadsDir);
  const candidate = path.resolve(root, storageKey);
  return candidate.startsWith(root + path.sep) ? candidate : null;
}

function hasReference(db: Database.Database, assetId: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM post_media WHERE asset_id = ?
    UNION ALL
    SELECT 1 FROM user_avatar_uploads WHERE asset_id = ?
    LIMIT 1
  `).get(assetId, assetId);
}

export function reclaimManagedAssets(
  db: Database.Database,
  options: ReclamationOptions,
): ReclamationResult {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const result: ReclamationResult = {
    disabled: false,
    pendingExpired: 0,
    considered: 0,
    deleted: 0,
    failed: 0,
    untrackedConsidered: 0,
    untrackedDeleted: 0,
  };

  const pending = db.prepare(`
    UPDATE managed_assets
    SET state = 'reclaimable',
        detached_at_ms = ?,
        reclaim_after_ms = ?
    WHERE state = 'pending'
      AND pending_expires_at_ms IS NOT NULL
      AND pending_expires_at_ms <= ?
  `).run(nowMs, nowMs + DETACHED_ASSET_GRACE_MS, nowMs);
  result.pendingExpired = pending.changes;

  if (
    options.nodeEnv === 'production' ||
    options.allowPhysicalDeletion !== true
  ) {
    result.disabled = true;
    return result;
  }

  const candidates = db.prepare(`
    SELECT id, storage_key
    FROM managed_assets
    WHERE state = 'reclaimable'
      AND reclaim_after_ms IS NOT NULL
      AND reclaim_after_ms <= ?
    ORDER BY reclaim_after_ms, id
    LIMIT ?
  `).all(nowMs, limit) as Array<{ id: string; storage_key: string }>;
  const unlinkFile = options.unlinkFile ?? fs.unlinkSync;

  for (const asset of candidates) {
    result.considered += 1;
    if (hasReference(db, asset.id)) {
      db.prepare(`
        UPDATE managed_assets
        SET reclaim_attempts = reclaim_attempts + 1,
            last_reclaim_error = 'asset is still referenced'
        WHERE id = ?
      `).run(asset.id);
      result.failed += 1;
      continue;
    }

    const filePath = managedFilePath(options.uploadsDir, asset.storage_key);
    if (!filePath) {
      db.prepare(`
        UPDATE managed_assets
        SET reclaim_attempts = reclaim_attempts + 1,
            last_reclaim_error = 'unsafe storage key'
        WHERE id = ?
      `).run(asset.id);
      result.failed += 1;
      continue;
    }

    try {
      let exists = false;
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe file type');
        exists = true;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (exists) unlinkFile(filePath);
      db.prepare(`
        UPDATE managed_assets
        SET state = 'deleted',
            deleted_at_ms = ?,
            reclaim_attempts = reclaim_attempts + 1,
            last_reclaim_error = ''
        WHERE id = ? AND state = 'reclaimable'
      `).run(nowMs, asset.id);
      result.deleted += 1;
    } catch (error: any) {
      db.prepare(`
        UPDATE managed_assets
        SET reclaim_attempts = reclaim_attempts + 1,
            last_reclaim_error = ?
        WHERE id = ?
      `).run(String(error?.message || 'filesystem deletion failed').slice(0, 300), asset.id);
      result.failed += 1;
    }
  }

  // A process can stop after multer creates a server-named file but before its
  // asset row commits. Only the reserved managed namespace is considered, and
  // only after the full pending TTL plus grace period. A fresh DB lookup closes
  // the scan/insert race before unlinking.
  const remaining = Math.max(0, limit - result.considered);
  if (remaining > 0) {
    const cutoffMs = nowMs - PENDING_ASSET_TTL_MS - DETACHED_ASSET_GRACE_MS;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.resolve(options.uploadsDir), { withFileTypes: true }); } catch { /* retry next run */ }
    const tracked = db.prepare('SELECT 1 FROM managed_assets WHERE storage_key = ?');
    for (const entry of entries) {
      if (result.untrackedConsidered >= remaining) break;
      if (!entry.isFile() || entry.isSymbolicLink() || !MANAGED_STORAGE_KEY.test(entry.name)) continue;
      const filePath = managedFilePath(options.uploadsDir, entry.name);
      if (!filePath || tracked.get(entry.name)) continue;
      let stat: fs.Stats;
      try { stat = fs.lstatSync(filePath); } catch { continue; }
      if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs > cutoffMs) continue;
      result.untrackedConsidered += 1;
      try {
        // Recheck after the age gate in case the DB transaction completed while
        // the directory was scanned.
        if (tracked.get(entry.name)) continue;
        unlinkFile(filePath);
        result.untrackedDeleted += 1;
      } catch {
        result.failed += 1;
      }
    }
  }
  return result;
}

export function listUntrackedManagedFiles(
  db: Database.Database,
  uploadsDir: string,
): string[] {
  const root = path.resolve(uploadsDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const tracked = db.prepare('SELECT 1 FROM managed_assets WHERE storage_key = ?');
  return entries
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && MANAGED_STORAGE_KEY.test(entry.name))
    .filter(entry => !tracked.get(entry.name))
    .map(entry => entry.name)
    .sort();
}
