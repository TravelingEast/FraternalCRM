import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { bootstrapSuperAdmin } from './auth.js';
import { createSmsProvider } from './providers/sms.js';
import { createEmailProvider } from './providers/email.js';
import { processQueue } from './campaigns.js';

const config = loadConfig();
const db = openDb(config.dbFile);

if (bootstrapSuperAdmin(db, config.bootstrap)) {
  console.log(`Created statewide admin ${config.bootstrap.email}`);
}

const sms = createSmsProvider(config);
const email = createEmailProvider(config);
const app = createApp({ db, config, sms, email });

app.listen(config.port, () => {
  console.log(`${config.orientName} CRM listening on ${config.publicBaseUrl} (sms: ${sms.name}, email: ${email.name})`);
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
