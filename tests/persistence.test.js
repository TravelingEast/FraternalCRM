import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, get } from '../src/db.js';
import { backupDb, maybeBackup } from '../src/backup.js';
import { upsertContact } from '../src/contacts.js';
import { seedValley } from './helpers.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'frc-'));

test('data survives closing and reopening the database file', () => {
  const dir = tmp();
  const file = path.join(dir, 'crm.sqlite');
  const db = openDb(file);
  const v = seedValley(db);
  upsertContact(db, v, { email: 'keep@x.org' });
  db.close();
  const again = openDb(file);
  assert.equal(get(again, 'SELECT COUNT(*) AS n FROM contacts').n, 1);
});

test('backup is a complete, openable copy and old ones are pruned', () => {
  const dir = tmp();
  const db = openDb(path.join(dir, 'crm.sqlite'));
  const v = seedValley(db);
  upsertContact(db, v, { email: 'backup@x.org' });
  const backups = path.join(dir, 'backups');
  for (let i = 0; i < 4; i++) backupDb(db, backups, { keep: 2, now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
  const files = fs.readdirSync(backups).sort();
  assert.equal(files.length, 2);
  assert.match(files[1], /20260101T000003Z/);
  const copy = new DatabaseSync(path.join(backups, files[1]), { readOnly: true });
  assert.equal(copy.prepare('SELECT email FROM contacts').get().email, 'backup@x.org');
  assert.equal(fs.statSync(path.join(backups, files[1])).mode & 0o077, 0, 'backup file is private to the owner');
});

test('automatic backup runs only when the newest is older than the interval', () => {
  const dir = tmp();
  const db = openDb(path.join(dir, 'crm.sqlite'));
  const opts = { dir: path.join(dir, 'b'), everyHours: 24, keep: 5 };
  assert.ok(maybeBackup(db, opts), 'first run takes a backup');
  assert.equal(maybeBackup(db, opts), null, 'second run within 24h does nothing');
  assert.equal(maybeBackup(db, { ...opts, everyHours: 0 }), null, 'zero disables backups');
});

test('a database from before the rich-text editor is upgraded in place', () => {
  const dir = tmp();
  const file = path.join(dir, 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE valleys (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, city TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE TABLE campaigns (id INTEGER PRIMARY KEY, valley_id INTEGER NOT NULL, name TEXT NOT NULL, channel TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, list_id INTEGER, status TEXT NOT NULL, scheduled_at TEXT, created_by INTEGER, created_at TEXT NOT NULL, started_at TEXT, sent_at TEXT);
    INSERT INTO valleys (name, created_at) VALUES ('V', 'n');
    INSERT INTO campaigns (valley_id, name, channel, body, status, created_at) VALUES (1, 'Old one', 'sms', 'hello', 'sent', 'n');`);
  old.close();
  const db = openDb(file);
  const row = get(db, 'SELECT name, body_html FROM campaigns');
  assert.deepEqual({ ...row }, { name: 'Old one', body_html: '' });
  assert.equal(get(db, 'PRAGMA user_version').user_version, 1);
});

test('a database from a newer app version is refused instead of corrupted', () => {
  const dir = tmp();
  const file = path.join(dir, 'new.sqlite');
  const db = openDb(file);
  db.exec('PRAGMA user_version = 99');
  db.close();
  assert.throws(() => openDb(file), /newer version/);
});
