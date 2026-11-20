// Usage: npm run admin -- you@example.org
// Resets that user's password, or creates a statewide admin if the email is new.
import readline from 'node:readline/promises';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { setAdminPassword } from '../src/admin.js';

if (fs.existsSync('.env')) process.loadEnvFile('.env');
const config = loadConfig();
const email = process.argv[2];
if (!email) {
  console.error('Usage: npm run admin -- you@example.org');
  process.exit(1);
}

let password = process.env.NEW_PASSWORD;
if (!password) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const write = rl._writeToOutput;
  rl._writeToOutput = (s) => { if (!muted) write.call(rl, s); };
  process.stdout.write('New password (10+ characters, hidden): ');
  muted = true;
  password = await rl.question('');
  rl.close();
  process.stdout.write('\n');
}

try {
  const db = openDb(config.dbFile);
  const result = setAdminPassword(db, email, password);
  console.log(result === 'created' ? `Created statewide admin ${email}` : `Password reset for ${email}. They were signed out everywhere.`);
  console.log(`Database: ${config.dbFile}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
