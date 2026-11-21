// Usage: npm run backup [target-dir]
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { backupDb } from '../src/backup.js';

const config = loadConfig();
const db = openDb(config.dbFile);
console.log(`Backup written to ${backupDb(db, process.argv[2] || config.backupDir, { keep: config.backupKeep })}`);
