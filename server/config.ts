import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const PRODUCTION_DATABASE_PATH = path.join(PROJECT_ROOT, 'data', 'social.db');
export const PRODUCTION_UPLOADS_DIR = path.join(PROJECT_ROOT, 'uploads');
export const DEVELOPMENT_DATABASE_PATH = path.join(PROJECT_ROOT, 'data', 'dev-social.db');
export const DEVELOPMENT_UPLOADS_DIR = path.join(PROJECT_ROOT, 'uploads-dev');

export interface StorageConfig {
  nodeEnv: string;
  isProduction: boolean;
  isTest: boolean;
  databasePath: string;
  uploadsDir: string;
}

function resolveFromProject(value: string): string {
  return path.resolve(PROJECT_ROOT, value.trim());
}

/**
 * Resolve storage paths without creating or opening anything.
 *
 * Relative overrides are resolved from the repository root, never from the
 * caller's current working directory. Test mode deliberately has no fallback:
 * a test process must provide both paths explicitly.
 */
export function getStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const nodeEnv = (env.NODE_ENV || 'development').trim().toLowerCase();
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';
  const configuredDatabase = env.DATABASE_PATH?.trim();
  const configuredUploads = env.UPLOADS_DIR?.trim();

  if (isTest && (!configuredDatabase || !configuredUploads)) {
    throw new Error(
      '[storage] NODE_ENV=test requires explicit DATABASE_PATH and UPLOADS_DIR. ' +
      'Use the isolated test harness; tests never fall back to development or production storage.',
    );
  }

  const databasePath = configuredDatabase
    ? resolveFromProject(configuredDatabase)
    : isProduction
      ? PRODUCTION_DATABASE_PATH
      : DEVELOPMENT_DATABASE_PATH;
  const uploadsDir = configuredUploads
    ? resolveFromProject(configuredUploads)
    : isProduction
      ? PRODUCTION_UPLOADS_DIR
      : DEVELOPMENT_UPLOADS_DIR;

  if (!isProduction) {
    const unsafe: string[] = [];
    if (pathsReferToSameLocation(databasePath, PRODUCTION_DATABASE_PATH)) unsafe.push('DATABASE_PATH');
    if (pathsReferToSameLocation(uploadsDir, PRODUCTION_UPLOADS_DIR)) unsafe.push('UPLOADS_DIR');
    if (unsafe.length > 0) {
      throw new Error(
        `[storage] Refusing non-production startup: ${unsafe.join(' and ')} resolves to production storage. ` +
        'Choose an isolated development/test path or set NODE_ENV=production only for the real production service.',
      );
    }
  }

  return { nodeEnv, isProduction, isTest, databasePath, uploadsDir };
}

/** Resolve symlinks for existing path components so aliases cannot bypass guards. */
function canonicalPath(inputPath: string): string {
  let existing = path.resolve(inputPath);
  const missingParts: string[] = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingParts.unshift(path.basename(existing));
    existing = parent;
  }

  let base = existing;
  try { base = fs.realpathSync.native(existing); } catch { /* path.resolve result is still deterministic */ }
  return path.resolve(base, ...missingParts);
}

export function pathsReferToSameLocation(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

export function ensureDatabaseDirectory(config = getStorageConfig()): void {
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true, mode: 0o700 });
}

export function ensureUploadsDirectory(config = getStorageConfig()): void {
  fs.mkdirSync(config.uploadsDir, { recursive: true, mode: 0o700 });
}

export interface MaintenanceGuardOptions {
  confirmationFlag?: string;
  argv?: string[];
}

/**
 * Guard a development maintenance command before database.ts is imported.
 * This function does not create directories or open SQLite.
 */
export function assertSafeMaintenanceTarget(
  action: string,
  options: MaintenanceGuardOptions = {},
): StorageConfig {
  const config = getStorageConfig();
  const failures: string[] = [];

  if (config.isProduction) failures.push('NODE_ENV is production');
  if (pathsReferToSameLocation(config.databasePath, PRODUCTION_DATABASE_PATH)) {
    failures.push(`database path is production (${PRODUCTION_DATABASE_PATH})`);
  }
  if (pathsReferToSameLocation(config.uploadsDir, PRODUCTION_UPLOADS_DIR)) {
    failures.push(`uploads path is production (${PRODUCTION_UPLOADS_DIR})`);
  }

  const argv = options.argv ?? process.argv.slice(2);
  if (options.confirmationFlag && !argv.includes(options.confirmationFlag)) {
    failures.push(`required confirmation flag is missing (${options.confirmationFlag})`);
  }

  if (failures.length > 0) {
    throw new Error(
      `[safety] Refusing to ${action}.\n` +
      failures.map(reason => `  - ${reason}`).join('\n') + '\n' +
      'No database or uploads were opened. Use isolated development/test storage and the documented explicit flag.',
    );
  }

  return config;
}
