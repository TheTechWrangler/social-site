import fs from 'node:fs';
import path from 'node:path';

/** Refuse symlinks in every existing component, not just the leaf. */
export function assertNoSymlinks(filename: string): void {
  const absolute = path.resolve(filename);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink storage path refused'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Shared application/maintenance lease. Crashed leases require operator review. */
export function acquireStorageLease(databasePath: string): () => void {
  if (fs.existsSync(`${databasePath}.restore-journal`)) throw new Error('Unresolved restore journal; operator recovery required');
  const filename = `${databasePath}.operation-lock`;
  assertNoSymlinks(filename);
  const fd = fs.openSync(filename, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  fs.fsyncSync(fd);
  const identity = fs.fstatSync(fd);
  fs.closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    const current = fs.lstatSync(filename);
    if (current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('Storage lease changed');
    fs.unlinkSync(filename);
    released = true;
  };
}
