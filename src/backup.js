import fs from 'node:fs';
import path from 'node:path';

const PATTERN = /^fraternal-crm-.*\.sqlite$/;

function listBackups(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => PATTERN.test(f)).sort() : [];
}

// Writes a consistent copy of the live database. VACUUM INTO is safe while the app is running.
export function backupDb(db, dir, { keep = 14, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const file = path.join(dir, `fraternal-crm-${stamp}.sqlite`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  fs.chmodSync(file, 0o600); // contains contact data and password hashes
  const old = listBackups(dir).slice(0, Math.max(listBackups(dir).length - keep, 0));
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

// Takes a backup only if the newest one is older than everyHours. Returns the file, or null if none was due.
export function maybeBackup(db, { dir, everyHours, keep }) {
  if (!(everyHours > 0)) return null;
  const newest = listBackups(dir).at(-1);
  if (newest && Date.now() - fs.statSync(path.join(dir, newest)).mtimeMs < everyHours * 3600 * 1000) return null;
  return backupDb(db, dir, { keep });
}
