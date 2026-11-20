import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, seedUser } from './helpers.js';
import { get, run } from '../src/db.js';
import { setAdminPassword } from '../src/admin.js';
import { verifyPassword, createSession } from '../src/auth.js';

test('creates a statewide admin when the email is new', () => {
  const db = testDb();
  assert.equal(setAdminPassword(db, 'Boss@Example.org', 'a-long-passphrase'), 'created');
  const u = get(db, 'SELECT * FROM users');
  assert.equal(u.email, 'boss@example.org');
  assert.equal(u.role, 'super_admin');
  assert.ok(verifyPassword('a-long-passphrase', u.password_hash));
});

test('resets an existing password, re-enables the account and signs the user out', () => {
  const db = testDb();
  const id = seedUser(db, { email: 'boss@example.org', password: 'old-password-here' });
  run(db, 'UPDATE users SET active = 0 WHERE id = ?', id);
  createSession(db, id);
  assert.equal(setAdminPassword(db, 'boss@example.org', 'brand-new-passphrase'), 'reset');
  const u = get(db, 'SELECT * FROM users WHERE id = ?', id);
  assert.equal(u.active, 1);
  assert.ok(verifyPassword('brand-new-passphrase', u.password_hash));
  assert.ok(!verifyPassword('old-password-here', u.password_hash));
  assert.equal(get(db, 'SELECT COUNT(*) AS n FROM sessions').n, 0);
});

test('rejects short passwords and bad emails', () => {
  const db = testDb();
  assert.throws(() => setAdminPassword(db, 'boss@example.org', 'short'), /10 characters/);
  assert.throws(() => setAdminPassword(db, 'not-an-email', 'a-long-passphrase'), /valid email/);
});
