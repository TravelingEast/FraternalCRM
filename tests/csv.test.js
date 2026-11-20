import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../src/csv.js';

test('parses quoted fields, embedded commas, newlines and doubled quotes', () => {
  const rows = parseCsv('name,notes\r\n"Doe, Jane","said ""hi""\nline two"\r\n');
  assert.deepEqual(rows, [['name', 'notes'], ['Doe, Jane', 'said "hi"\nline two']]);
});

test('handles BOM, LF endings, blank lines and a missing final newline', () => {
  const rows = parseCsv('﻿email\na@b.com\n\nc@d.com');
  assert.deepEqual(rows, [['email'], ['a@b.com'], ['c@d.com']]);
});

test('rejects an unclosed quote', () => {
  assert.throws(() => parseCsv('a,"oops\n'), /unclosed/);
});

test('toCsv escapes special characters and neutralises formula injection', () => {
  const out = toCsv([['a', 'b'], ['x,y', '=HYPERLINK("bad")'], ['+15551234567', null]]);
  assert.equal(out, 'a,b\r\n"x,y","\'=HYPERLINK(""bad"")"\r\n+15551234567,\r\n');
});
