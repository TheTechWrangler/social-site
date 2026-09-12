import fs from 'node:fs';
import path from 'node:path';
import { getStorageConfig } from './config.js';
import { acquireStorageLease, assertNoSymlinks } from './storageSafety.js';

// Imported before database/routes: refuse startup while maintenance owns storage.
const storage = getStorageConfig();
assertNoSymlinks(storage.databasePath);
fs.mkdirSync(path.dirname(storage.databasePath), { recursive: true, mode: 0o700 });
const release = acquireStorageLease(storage.databasePath);
process.once('exit', release);
process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));
