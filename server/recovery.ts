import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { acquireStorageLease, assertNoSymlinks } from './storageSafety.js';
import { auditOperation } from './operationalAudit.js';

export const RECOVERY_FORMAT = 1;
export const RECOVERY_LIMITS = { files: 50000, bytes: 20 * 1024 ** 3, manifest: 16 * 1024 ** 2, sets: 30 };
const SET_ID = /^recovery-[a-f0-9-]{36}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
function* entries(root: string): Generator<fs.Dirent> {
  const dir = fs.opendirSync(root);
  try { let entry: fs.Dirent | null; while ((entry = dir.readSync())) yield entry; }
  finally { dir.closeSync(); }
}
interface Entry { name: string; bytes: number; sha256: string }
export interface Manifest {
  format: number; complete: true; createdAt: string; application: 'social-site';
  schema: string[]; database: Entry; uploads: Entry[]; totalBytes: number;
}
export interface RecoveryStorage { databasePath: string; uploadsDir: string; backupRoot: string }
export interface RecoveryHooks { checkpoint?: (step: string) => void }

function directory(root: string): void {
  assertNoSymlinks(root);
  if (!fs.statSync(root).isDirectory()) throw new Error('Expected storage directory');
}
function contained(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function validateStorage(storage: RecoveryStorage): void {
  for (const value of [storage.databasePath, storage.uploadsDir, storage.backupRoot]) {
    if (!path.isAbsolute(value) || value === path.parse(value).root) throw new Error('Explicit absolute storage paths required');
    assertNoSymlinks(value);
  }
  if (contained(storage.uploadsDir, storage.backupRoot) || contained(storage.backupRoot, storage.uploadsDir)
    || contained(storage.backupRoot, storage.databasePath) || contained(storage.uploadsDir, storage.databasePath)) {
    throw new Error('Recovery storage paths overlap');
  }
  directory(storage.uploadsDir);
  directory(storage.backupRoot);
}

/** Bounded-memory hashing with no-follow open and identity/change detection. */
export function fileEvidence(filename: string): Omit<Entry, 'name'> {
  assertNoSymlinks(filename);
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > RECOVERY_LIMITS.bytes) throw new Error('Unsafe file');
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let bytes = 0, count: number;
    while ((count = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      bytes += count;
      if (bytes > RECOVERY_LIMITS.bytes) throw new Error('File size limit exceeded');
      digest.update(chunk.subarray(0, count));
    }
    const after = fs.fstatSync(fd), leaf = fs.lstatSync(filename);
    if (bytes !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || leaf.ino !== before.ino || leaf.dev !== before.dev || leaf.isSymbolicLink()) throw new Error('File changed during verification');
    return { bytes, sha256: digest.digest('hex') };
  } finally { fs.closeSync(fd); }
}
function syncFile(filename: string): void {
  const fd = fs.openSync(filename, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function copyChecked(source: string, destination: string, expected?: Entry): Entry {
  const evidence = fileEvidence(source);
  if (expected && (expected.bytes !== evidence.bytes || expected.sha256 !== evidence.sha256)) throw new Error('Checksum mismatch');
  assertNoSymlinks(destination);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const copied = fileEvidence(destination);
  if (copied.bytes !== evidence.bytes || copied.sha256 !== evidence.sha256) throw new Error('Copy verification failed');
  syncFile(destination);
  return { name: path.basename(destination), ...evidence };
}
function schema(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: string }[]).map(row => row.id);
}
function checkDatabase(filename: string, expectedSchema?: string[]): string[] {
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Invalid recovery database');
    const versions = schema(db);
    if (!versions.includes('015-atomic-baseline') || (expectedSchema && JSON.stringify(versions) !== JSON.stringify(expectedSchema))) {
      throw new Error('Incompatible recovery schema');
    }
    return versions;
  } finally { db.close(); }
}

function validateReferences(databasePath: string, names: Set<string>): void {
  const db = new Database(databasePath, { readonly: true });
  try {
    // Legacy local media remains recoverable even without a managed-asset row.
    const refs = db.prepare(`SELECT url FROM post_media UNION SELECT thumbnail_url AS url FROM post_media UNION SELECT url FROM user_avatar_uploads
      UNION SELECT avatar_url AS url FROM users
      UNION SELECT url FROM managed_assets WHERE state IN ('active','pending')
      UNION SELECT cover_image_url AS url FROM games`);
    for (const row of refs.iterate() as Iterable<{ url: string }>) {
      if (!row.url?.startsWith('/uploads/')) continue;
      const name = row.url.slice('/uploads/'.length);
      if (!FILE_NAME.test(name) || !names.has(name)) throw new Error('Recovery point is missing referenced upload');
    }
  } finally { db.close(); }
}

/** Read-only, strict validation. No state replacement is possible before this succeeds. */
export function verifyRecoverySet(root: string, id: string): Manifest {
  if (!SET_ID.test(id)) throw new Error('Invalid recovery set ID');
  const folder = path.join(root, id);
  directory(folder);
  const filename = path.join(folder, 'manifest.json');
  assertNoSymlinks(filename);
  if (fs.statSync(filename).size > RECOVERY_LIMITS.manifest) throw new Error('Manifest too large');
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8')) as Manifest;
  if (manifest.format !== RECOVERY_FORMAT || manifest.complete !== true || manifest.application !== 'social-site'
    || !Array.isArray(manifest.schema) || manifest.schema.length > 100 || manifest.schema.some(id => typeof id !== 'string')
    || !Array.isArray(manifest.uploads) || manifest.uploads.length > RECOVERY_LIMITS.files
    || !Number.isFinite(Date.parse(manifest.createdAt)) || manifest.database?.name !== 'database.sqlite') throw new Error('Invalid recovery manifest');
  let total = 0;
  const names = new Set<string>();
  for (const entry of [manifest.database, ...manifest.uploads]) {
    if (!entry || !FILE_NAME.test(entry.name) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid manifest entry');
    const prefix = entry === manifest.database ? folder : path.join(folder, 'uploads');
    if (entry !== manifest.database) {
      if (names.has(entry.name)) throw new Error('Duplicate manifest entry');
      names.add(entry.name);
    }
    total += entry.bytes;
    if (total > RECOVERY_LIMITS.bytes) throw new Error('Recovery size limit exceeded');
    const actual = fileEvidence(path.join(prefix, entry.name));
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error('Checksum mismatch');
  }
  if (total !== manifest.totalBytes) throw new Error('Invalid manifest total');
  checkDatabase(path.join(folder, 'database.sqlite'), manifest.schema);
  validateReferences(path.join(folder, 'database.sqlite'), names);
  return manifest;
}

function createLocked(storage: RecoveryStorage, hooks: RecoveryHooks): string {
  // Bound all entries, including stale staging directories; never prune recovery evidence automatically.
  let count = 0;
  for (const _entry of entries(storage.backupRoot)) { if (++count >= RECOVERY_LIMITS.sets) throw new Error('Recovery root full; verify and archive old sets first'); }
  const id = `recovery-${randomUUID()}`;
  const staging = path.join(storage.backupRoot, `.staging-${id}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  fs.mkdirSync(path.join(staging, 'uploads'), { mode: 0o700 });
  const db = new Database(storage.databasePath, { fileMustExist: true });
  try {
    auditOperation(db, 'backup.started', null, 'backup', id);
    // SQLite's WAL-aware snapshot; never copy a live main DB alone.
    db.prepare('VACUUM INTO ?').run(path.join(staging, 'database.sqlite'));
    hooks.checkpoint?.('snapshot');
    const versions = checkDatabase(path.join(staging, 'database.sqlite'));
    const database = { name: 'database.sqlite', ...fileEvidence(path.join(staging, 'database.sqlite')) };
    const uploads: Entry[] = [];
    let totalBytes = database.bytes;
    for (const entry of entries(storage.uploadsDir)) {
      if (uploads.length >= RECOVERY_LIMITS.files || !entry.isFile() || !FILE_NAME.test(entry.name)) throw new Error('Unsupported upload inventory');
      const source = path.join(storage.uploadsDir, entry.name);
      if (totalBytes + fs.lstatSync(source).size > RECOVERY_LIMITS.bytes) throw new Error('Recovery size limit exceeded');
      const copied = copyChecked(source, path.join(staging, 'uploads', entry.name));
      uploads.push(copied); totalBytes += copied.bytes;
    }
    uploads.sort((a,b) => a.name.localeCompare(b.name));
    const manifest: Manifest = { format: RECOVERY_FORMAT, complete: true, application: 'social-site',
      createdAt: new Date().toISOString(), schema: versions, database, uploads, totalBytes };
    const json = JSON.stringify(manifest);
    if (Buffer.byteLength(json) > RECOVERY_LIMITS.manifest) throw new Error('Manifest too large');
    validateReferences(path.join(staging, 'database.sqlite'), new Set(uploads.map(file => file.name)));
    fs.writeFileSync(path.join(staging, 'manifest.json'), json, { flag: 'wx', mode: 0o600 });
    syncFile(path.join(staging, 'database.sqlite')); syncFile(path.join(staging, 'manifest.json'));
    syncFile(path.join(staging, 'uploads')); syncFile(staging);
    hooks.checkpoint?.('before-complete');
    auditOperation(db, 'backup.prepared', null, 'backup', id);
    fs.renameSync(staging, path.join(storage.backupRoot, id)); syncFile(storage.backupRoot);
    auditOperation(db, 'backup.completed', null, 'backup', id);
    return id;
  } catch (error) {
    auditOperation(db, 'backup.failed', null, 'backup', id);
    throw error; // Staging is preserved, never returned/listed as complete.
  } finally { db.close(); }
}

export function createRecoverySet(storage: RecoveryStorage, hooks: RecoveryHooks = {}): string {
  validateStorage(storage);
  const release = acquireStorageLease(storage.databasePath);
  try { return createLocked(storage, hooks); } finally { release(); }
}

/** Offline only. Reversible renames retain original state; crashes retain the lease and journal. */
export function restoreRecoverySet(storage: RecoveryStorage, id: string, hooks: RecoveryHooks = {}): { recoveryPoint: string } {
  validateStorage(storage);
  const release = acquireStorageLease(storage.databasePath);
  let safeToRelease = true;
  try {
    const manifest = verifyRecoverySet(storage.backupRoot, id);
    const current = checkDatabase(storage.databasePath);
    if (JSON.stringify(manifest.schema) !== JSON.stringify(current)) throw new Error('Restore requires matching schema versions');
    const suffix = randomUUID();
    const stagedDb = `${storage.databasePath}.restore-${suffix}`;
    const stagedUploads = `${storage.uploadsDir}.restore-${suffix}`;
    fs.mkdirSync(stagedUploads, { mode: 0o700 });
    const folder = path.join(storage.backupRoot, id);
    copyChecked(path.join(folder, 'database.sqlite'), stagedDb, manifest.database);
    for (const entry of manifest.uploads) copyChecked(path.join(folder, 'uploads', entry.name), path.join(stagedUploads, entry.name), entry);
    hooks.checkpoint?.('staged');
    const recoveryPoint = createLocked(storage, {});
    const restored = new Database(stagedDb);
    try {
      restored.transaction(() => {
        // Never resurrect a stolen/revoked login or reset credential from history.
        restored.exec('DELETE FROM sessions; DELETE FROM application_auth_sessions; DELETE FROM password_reset_tokens; DELETE FROM email_verification_tokens;');
        restored.prepare('UPDATE users SET auth_version = ?').run(Date.now());
        auditOperation(restored, 'restore.completed', null, 'backup', id);
      })();
    } finally { restored.close(); }
    syncFile(stagedDb); syncFile(stagedUploads);
    // The pre-restore VACUUM snapshot included WAL; checkpoint before retaining original files.
    const active = new Database(storage.databasePath);
    try {
      const result = active.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[];
      if (result.some(row => row.busy)) throw new Error('Database is busy; stop all writers');
    } finally { active.close(); }
    const operations: [string,string][] = [];
    for (const sidecar of ['-wal','-shm']) if (fs.existsSync(storage.databasePath + sidecar)) operations.push([storage.databasePath + sidecar, storage.databasePath + `.previous-${suffix}${sidecar}`]);
    operations.push([storage.databasePath, `${storage.databasePath}.previous-${suffix}`],
      [storage.uploadsDir, `${storage.uploadsDir}.previous-${suffix}`], [stagedDb, storage.databasePath], [stagedUploads, storage.uploadsDir]);
    const journal = `${storage.databasePath}.restore-journal`;
    fs.writeFileSync(journal, JSON.stringify({ id, recoveryPoint, operations }), { flag: 'wx', mode: 0o600 }); syncFile(journal);
    let completed = 0;
    try {
      for (const [from,to] of operations) {
        assertNoSymlinks(from); assertNoSymlinks(to);
        if (fs.existsSync(to)) throw new Error('Restore destination already exists');
        fs.renameSync(from,to); completed++; hooks.checkpoint?.(`rename-${completed}`);
      }
      syncFile(path.dirname(storage.databasePath)); syncFile(path.dirname(storage.uploadsDir));
      fs.unlinkSync(journal);
      return { recoveryPoint };
    } catch (error) {
      try {
        for (const [from,to] of operations.slice(0,completed).reverse()) fs.renameSync(to,from);
        fs.unlinkSync(journal);
      } catch { safeToRelease = false; throw new Error('Restore rollback incomplete: keep maintenance mode; inspect recovery journal'); }
      throw error;
    }
  } finally { if (safeToRelease) release(); }
}
