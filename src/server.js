import fs from 'node:fs';
import { loadConfig } from './config.js';
import { get, openDb } from './db.js';
import { createApp } from './app.js';
import { bootstrapSuperAdmin } from './auth.js';
import { createSmsProvider } from './providers/sms.js';
import { createEmailProvider } from './providers/email.js';
import { processQueue } from './campaigns.js';
import { maybeBackup } from './backup.js';

// Read .env from the folder the app is started in. Variables already set in the shell win.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const db = openDb(config.dbFile);

const created = bootstrapSuperAdmin(db, config.bootstrap);
const { n: userCount } = get(db, 'SELECT COUNT(*) AS n FROM users');
console.log(`Database: ${config.dbFile}`);
if (created) {
  console.log(`Created statewide admin ${config.bootstrap.email}`);
} else if (userCount === 0) {
  console.warn('No users exist yet, so nobody can sign in. Set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in .env, or run: npm run admin -- you@example.org');
} else if (config.bootstrap.email) {
  console.log('Users already exist, so SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD were ignored. To change a password run: npm run admin -- <email>');
}

const sms = createSmsProvider(config);
const email = createEmailProvider(config);
const app = createApp({ db, config, sms, email });

app.listen(config.port, () => {
  console.log(`${config.orientName} CRM listening on port ${config.port}, public address ${config.publicBaseUrl} (sms: ${sms.name}, email: ${email.name})`);
});

setInterval(() => {
  processQueue(db, {
    sms,
    email,
    publicBaseUrl: config.publicBaseUrl,
    smsPerTick: config.smsPerTick,
    emailPerTick: config.emailPerTick,
    log: (msg) => console.error(msg),
  }).catch((err) => console.error('queue error:', err));
}, config.tickMs);

// Automatic backups of the database file. Check hourly, take one when the newest is older than BACKUP_EVERY_HOURS.
if (config.dbFile !== ':memory:') {
  const backup = () => {
    try {
      const file = maybeBackup(db, { dir: config.backupDir, everyHours: config.backupEveryHours, keep: config.backupKeep });
      if (file) console.log(`Backup written to ${file}`);
    } catch (err) {
      console.error('backup failed:', err.message);
    }
  };
  backup();
  setInterval(backup, 60 * 60 * 1000).unref();
}
