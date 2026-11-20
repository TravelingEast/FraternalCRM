import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, seedValley } from './helpers.js';
import { get, all } from '../src/db.js';
import { importContacts, upsertContact } from '../src/contacts.js';
import { contactsToCsv } from '../src/contacts.js';

test('import dedupes by email and phone, fills blanks, and never overwrites filled fields', () => {
  const db = testDb();
  const v = seedValley(db);
  importContacts(db, v, 'First,Last,Email,Phone\nJane,Doe,jane@x.org,555-111-2222\n', { consentEmail: true });
  const summary = importContacts(
    db, v,
    'first_name,last_name,email,phone,notes\nJ,Smith,JANE@x.org,,"new note"\nBob,Brown,,(555) 111-2222,\nNobody,Here,,,\n',
  );
  assert.equal(summary.created, 0);
  assert.equal(summary.matched, 2);
  assert.equal(summary.skipped, 1);
  const jane = get(db, 'SELECT * FROM contacts WHERE email = ?', 'jane@x.org');
  assert.equal(jane.first_name, 'Jane', 'existing first name must not be overwritten');
  assert.equal(jane.notes, 'new note', 'blank notes field should be filled');
  assert.equal(jane.email_opt_in, 1, 'email consent from first import persists');
});

test('an opted-out person is never re-subscribed by import or API', () => {
  const db = testDb();
  const v = seedValley(db);
  upsertContact(db, v, { email: 'a@x.org', email_opt_in: true });
  db.prepare('UPDATE contacts SET email_suppressed = 1, email_opt_in = 0').run();
  const summary = importContacts(db, v, 'email\na@x.org\n', { consentEmail: true });
  const row = get(db, 'SELECT * FROM contacts WHERE email = ?', 'a@x.org');
  assert.equal(row.email_suppressed, 1);
  assert.equal(row.email_opt_in, 0);
  assert.equal(summary.opted_out_not_resubscribed, 1);
  const api = upsertContact(db, v, { email: 'a@x.org', email_opt_in: true }, { source: 'api' });
  assert.equal(api.consent.email, 'suppressed');
});

test('consent is logged and import into a list adds members', () => {
  const db = testDb();
  const v = seedValley(db);
  db.prepare("INSERT INTO lists (valley_id, name, created_at) VALUES (?, 'Members', 'now')").run(v);
  const list = get(db, 'SELECT id FROM lists WHERE valley_id = ?', v);
  importContacts(db, v, 'email,phone\na@x.org,\n,555-010-0100\n', { listId: list.id, consentEmail: true, consentSms: true, source: 'import:1' });
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM list_members').n, 2);
  const logs = all(db, 'SELECT channel, action, source FROM consent_log ORDER BY id');
  assert.deepEqual(logs.map((l) => `${l.channel}:${l.action}`), ['email:opt_in', 'sms:opt_in']);
  assert.equal(logs[0].source, 'import:1');
});

test('import needs an email or phone column and rejects header-only files', () => {
  const db = testDb();
  const v = seedValley(db);
  assert.throws(() => importContacts(db, v, 'name,notes\nJane,hi\n'), /email" or "phone/);
  assert.throws(() => importContacts(db, v, 'email\n'), /header row and at least one/);
});

test('a phone number in another valley does not block import', () => {
  const db = testDb();
  const a = seedValley(db, 'A');
  const b = seedValley(db, 'B');
  importContacts(db, a, 'phone\n555-222-3333\n');
  const summary = importContacts(db, b, 'phone\n555-222-3333\n');
  assert.equal(summary.created, 1);
});

test('export produces a CSV with consent flags', () => {
  const db = testDb();
  const v = seedValley(db);
  importContacts(db, v, 'first_name,email\nJane,jane@x.org\n', { consentEmail: true });
  const csv = contactsToCsv(db, v);
  const [header, row] = csv.trim().split('\r\n');
  assert.match(header, /^first_name,last_name,email,phone,email_opt_in/);
  assert.equal(row, 'Jane,,jane@x.org,,1,0,0,0,,' + row.split(',').at(-1));
});
