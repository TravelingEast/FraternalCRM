import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS valleys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  city TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'valley_admin')),
  valley_id INTEGER REFERENCES valleys(id) ON DELETE CASCADE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  CHECK ((role = 'super_admin' AND valley_id IS NULL) OR (role = 'valley_admin' AND valley_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY,
  valley_id INTEGER NOT NULL REFERENCES valleys(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  valley_id INTEGER NOT NULL REFERENCES valleys(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  phone TEXT,
  email_opt_in INTEGER NOT NULL DEFAULT 0,
  email_suppressed INTEGER NOT NULL DEFAULT 0,
  sms_opt_in INTEGER NOT NULL DEFAULT 0,
  sms_suppressed INTEGER NOT NULL DEFAULT 0,
  unsub_token TEXT NOT NULL UNIQUE,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_valley_email ON contacts (valley_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_valley_phone ON contacts (valley_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_phone ON contacts (phone);

CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  valley_id INTEGER NOT NULL REFERENCES valleys(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (valley_id, name)
);

CREATE TABLE IF NOT EXISTS list_members (
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY (list_id, contact_id)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  valley_id INTEGER NOT NULL REFERENCES valleys(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  list_id INTEGER REFERENCES lists(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')),
  scheduled_at TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS campaigns_due ON campaigns (status, scheduled_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  to_address TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  reason TEXT,
  provider_id TEXT,
  sent_at TEXT,
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX IF NOT EXISTS messages_queue ON messages (status, channel, id);

CREATE TABLE IF NOT EXISTS consent_log (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  action TEXT NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

// Values node:sqlite cannot bind: undefined becomes NULL, booleans become 0/1.
const clean = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

const SCHEMA_VERSION = 1;

// Upgrades a database created by an older release. Add a step here whenever the schema changes.
function migrate(db) {
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version > SCHEMA_VERSION) {
    throw new Error(`This database is from a newer version of the app (schema ${version}). Update the app before opening it.`);
  }
  const campaignCols = db.prepare('PRAGMA table_info(campaigns)').all().map((c) => c.name);
  if (!campaignCols.includes('body_html')) {
    db.exec("ALTER TABLE campaigns ADD COLUMN body_html TEXT NOT NULL DEFAULT ''");
  }
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const all = (db, sql, ...params) => db.prepare(sql).all(...params.map(clean));
export const get = (db, sql, ...params) => db.prepare(sql).get(...params.map(clean));
export const run = (db, sql, ...params) => db.prepare(sql).run(...params.map(clean));

// Runs fn inside a write transaction. Throwing rolls everything back.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
