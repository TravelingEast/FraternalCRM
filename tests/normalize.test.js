import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEmail, normalizePhone, mapHeaders } from '../src/contacts.js';

test('emails are trimmed, lowercased and validated', () => {
  assert.equal(normalizeEmail('  Jane.Doe@Example.ORG '), 'jane.doe@example.org');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizeEmail('a b@c.org'), null);
  assert.equal(normalizeEmail(undefined), null);
});

test('phones normalise to E.164', () => {
  assert.equal(normalizePhone('(555) 123-4567'), '+15551234567');
  assert.equal(normalizePhone('1-555-123-4567'), '+15551234567');
  assert.equal(normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePhone('abc'), null);
  assert.equal(normalizePhone(''), null);
});

test('header mapping recognises common column names', () => {
  const map = mapHeaders(['First Name', 'Surname', 'E-mail', 'Mobile Phone', 'Favourite colour']);
  assert.deepEqual(map, { first_name: 0, last_name: 1, email: 2, phone: 3 });
});
