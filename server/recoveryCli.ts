import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getStorageConfig } from './config.js';
import { acquireStorageLease, assertNoSymlinks } from './storageSafety.js';
import { createRecoverySet, restoreRecoverySet, verifyRecoverySet } from './recovery.js';
import { reclaimManagedAssets } from './assetLifecycle.js';

// No import of database.ts: operations must not start migrations or create a DB.
const config = getStorageConfig();
const [action, id, confirmation] = process.argv.slice(2);
try {
  if (!process.env.DATABASE_PATH || !process.env.UPLOADS_DIR) throw new Error('Set explicit DATABASE_PATH and UPLOADS_DIR');
  if (action === 'gc-dry-run') {
    const release = acquireStorageLease(config.databasePath);
    try {
      const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
      try { console.log(JSON.stringify(reclaimManagedAssets(db, { uploadsDir: config.uploadsDir, nodeEnv: config.nodeEnv, dryRun: true }))); }
      finally { db.close(); }
    } finally { release(); }
  } else {
    const root = process.env.RECOVERY_ROOT;
    if (!root || !path.isAbsolute(root)) throw new Error('Set an explicit absolute RECOVERY_ROOT');
    assertNoSymlinks(root);
    if (!fs.existsSync(root)) throw new Error('Create a dedicated private recovery directory first');
    const storage = { ...config, backupRoot: root };
    if (action === 'backup' && id === '--maintenance-confirmed') console.log(JSON.stringify({ id: createRecoverySet(storage) }));
    else if (action === 'verify' && id) { const manifest = verifyRecoverySet(root, id); console.log(JSON.stringify({ id, verified: true, totalBytes: manifest.totalBytes, files: manifest.uploads.length })); }
    else if (action === 'restore' && id && confirmation === '--restore-offline-confirmed') console.log(JSON.stringify(restoreRecoverySet(storage, id)));
    else throw new Error('Use backup --maintenance-confirmed, verify <set-id>, restore <set-id> --restore-offline-confirmed, or gc-dry-run');
  }
} catch (error) {
  console.error(`[recovery] ${(error as Error).message}`);
  process.exitCode = 1;
}
