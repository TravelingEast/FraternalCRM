import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, seedValley, fakeProviders } from './helpers.js';
import { get, run } from '../src/db.js';
import { upsertContact, addToList } from '../src/contacts.js';
import { createCampaign, startCampaign, processQueue, renderMessage, campaignView } from '../src/campaigns.js';
import { nowIso } from '../src/util.js';

const PUBLIC = 'https://crm.example.org';

function setup() {
  const db = testDb();
  const valley = seedValley(db, 'Sample Valley');
  const listId = Number(run(db, 'INSERT INTO lists (valley_id, name, created_at) VALUES (?, ?, ?)', valley, 'Members', nowIso()).lastInsertRowid);
  const ids = {};
  ids.optedIn = upsertContact(db, valley, { first_name: 'Ann', email: 'ann@x.org', phone: '555-000-0001', email_opt_in: true, sms_opt_in: true }).id;
  ids.emailOnly = upsertContact(db, valley, { first_name: 'Ben', email: 'ben@x.org' }).id;
  ids.smsStopped = upsertContact(db, valley, { first_name: 'Cy', phone: '555-000-0003', sms_opt_in: true }).id;
  run(db, 'UPDATE contacts SET sms_suppressed = 1, sms_opt_in = 0 WHERE id = ?', ids.smsStopped);
  addToList(db, listId, [ids.optedIn, ids.emailOnly, ids.smsStopped]);
  return { db, valley, listId, ids };
}

test('SMS campaign sends only to opted-in people and records the rest as skipped', async () => {
  const { db, valley, listId } = setup();
  const campaignId = createCampaign(db, valley, null, { name: 'Stated meeting', channel: 'sms', body: 'Stated meeting Tuesday.', list_id: listId });
  startCampaign(db, campaignId);
  const fake = fakeProviders();
  const totals = await processQueue(db, { sms: fake.smsProvider, email: fake.emailProvider, publicBaseUrl: PUBLIC, smsPerTick: 10, emailPerTick: 10 });
  assert.equal(totals.sent, 1);
  assert.equal(fake.sms.length, 1);
  assert.equal(fake.sms[0].to, '+15550000001');
  assert.match(fake.sms[0].body, /Reply STOP to opt out\.$/);
  const view = campaignView(db, campaignId);
  assert.equal(view.status, 'sent');
  assert.equal(view.counts.sent, 1);
  assert.equal(view.counts.skipped, 2, 'email-only and STOPped contacts are skipped for SMS');
});

test('email campaign includes unsubscribe link, one-click headers and escapes merged text', async () => {
  const { db, valley, listId } = setup();
  const id = createCampaign(db, valley, null, {
    name: 'News', channel: 'email', subject: 'Hello {{first_name}}', body: 'Dear {{name}},\n<b>Tracing</b> board', list_id: listId,
  });
  startCampaign(db, id);
  const fake = fakeProviders();
  await processQueue(db, { sms: fake.smsProvider, email: fake.emailProvider, publicBaseUrl: PUBLIC, smsPerTick: 10, emailPerTick: 10 });
  assert.equal(fake.email.length, 1);
  const msg = fake.email[0];
  assert.equal(msg.subject, 'Hello Ann');
  assert.match(msg.text, /Dear Ann,/);
  const token = get(db, 'SELECT unsub_token FROM contacts WHERE email = ?', 'ann@x.org').unsub_token;
  assert.match(msg.headers['List-Unsubscribe'], new RegExp(`/unsubscribe/${token}>`));
  assert.equal(msg.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(msg.html, /&lt;b&gt;Tracing&lt;\/b&gt;/, 'body must be escaped in HTML');
  assert.doesNotMatch(msg.html, /<b>Tracing/);
});

test('a STOP received after the audience was snapshotted is honoured at send time', async () => {
  const { db, valley, listId, ids } = setup();
  const id = createCampaign(db, valley, null, { name: 'Late', channel: 'sms', body: 'Hi', list_id: listId });
  startCampaign(db, id);
  run(db, 'UPDATE contacts SET sms_suppressed = 1, sms_opt_in = 0 WHERE id = ?', ids.optedIn);
  const fake = fakeProviders();
  const totals = await processQueue(db, { sms: fake.smsProvider, email: fake.emailProvider, publicBaseUrl: PUBLIC, smsPerTick: 10, emailPerTick: 10 });
  assert.equal(fake.sms.length, 0);
  assert.equal(totals.skipped, 1);
});

test('provider errors mark the message failed without stopping the batch', async () => {
  const { db, valley, listId } = setup();
  const id = createCampaign(db, valley, null, { name: 'Err', channel: 'email', subject: 'S', body: 'B', list_id: listId });
  startCampaign(db, id);
  const failing = { async send() { throw new Error('mailbox full'); } };
  const totals = await processQueue(db, { sms: failing, email: failing, publicBaseUrl: PUBLIC, smsPerTick: 10, emailPerTick: 10 });
  assert.equal(totals.failed, 1);
  const view = campaignView(db, id);
  assert.equal(view.counts.failed, 1);
  assert.equal(view.counts.sent, 0);
  assert.equal(view.status, 'sent', 'campaign closes once nothing is pending');
});

test('batch size limits how many messages go out per tick', async () => {
  const { db, valley, listId } = setup();
  upsertContact(db, valley, { first_name: 'Dee', email: 'dee@x.org', email_opt_in: true });
  addToList(db, listId, [get(db, "SELECT id FROM contacts WHERE email = 'dee@x.org'").id]);
  const id = createCampaign(db, valley, null, { name: 'Batch', channel: 'email', subject: 'S', body: 'B', list_id: listId });
  startCampaign(db, id);
  const fake = fakeProviders();
  await processQueue(db, { sms: fake.smsProvider, email: fake.emailProvider, publicBaseUrl: PUBLIC, smsPerTick: 10, emailPerTick: 1 });
  assert.equal(fake.email.length, 1);
  assert.equal(campaignView(db, id).status, 'sending');
});

test('scheduled campaigns start when due and no one else is targeted', async () => {
  const { db, valley } = setup();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const id = createCampaign(db, valley, null, { name: 'Later', channel: 'sms', body: 'Soon', list_id: null, scheduled_at: future });
  assert.equal(campaignView(db, id).status, 'scheduled');
  const fake = fakeProviders();
  await processQueue(db, { sms: fake.smsProvider, email: fake.emailProvider, publicBaseUrl: PUBLIC });
  assert.equal(campaignView(db, id).status, 'scheduled', 'not due yet');
  run(db, 'UPDATE campaigns SET scheduled_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), id);
  await processQueue(db, { sms: fake.smsProvider, email: fake.emailProvider, publicBaseUrl: PUBLIC });
  assert.equal(campaignView(db, id).status, 'sent');
  assert.equal(fake.sms.length, 1, 'only the opted-in contact in the valley');
});

test('campaign validation refuses empty audiences, bad channels and missing subjects', () => {
  const { db, valley } = setup();
  assert.throws(() => createCampaign(db, valley, null, { name: 'x', channel: 'fax', body: 'b' }), /email" or "sms/);
  assert.throws(() => createCampaign(db, valley, null, { name: 'x', channel: 'email', body: 'b' }), /subject/);
  assert.throws(() => createCampaign(db, valley, null, { name: 'x', channel: 'sms', body: 'b', list_id: 'typo' }), /valid list/);
  assert.throws(() => createCampaign(db, valley, null, { name: 'x', channel: 'sms', body: 'b', list_id: 99999 }), /does not exist/);
  assert.throws(() => createCampaign(db, valley, null, { name: 'x', channel: 'sms', body: 'b', scheduled_at: '2000-01-01' }), /future/);
});

test('renderMessage fills merge fields and leaves unknown ones empty', () => {
  const out = renderMessage(
    { channel: 'sms', body: 'Hi {{first_name}} {{nope}}!', first_name: 'Ann', valley_name: 'V', unsub_token: 't' },
    { publicBaseUrl: PUBLIC },
  );
  assert.equal(out.text, 'Hi Ann !\n\nReply STOP to opt out.');
});

test('startCampaign on a finished campaign is refused', () => {
  const { db, valley, listId } = setup();
  const id = createCampaign(db, valley, null, { name: 'Once', channel: 'sms', body: 'b', list_id: listId });
  startCampaign(db, id);
  assert.throws(() => startCampaign(db, id), /already started/);
});

test('rich HTML from the editor is sanitised, gets a text version, and merge fields are escaped', async () => {
  const { db, valley, listId, ids } = setup();
  run(db, "UPDATE contacts SET first_name = '<i>Ann</i>' WHERE id = ?", ids.optedIn);
  const id = createCampaign(db, valley, null, {
    name: 'Rich', channel: 'email', subject: 'S', list_id: listId,
    body_html: '<h2>Hello {{first_name}}</h2><p onclick="x()">Read <a href="https://lodge.org/a?b=1&c=2">the notice</a><script>alert(1)</script></p><img src="javascript:alert(1)"><a href="{{unsubscribe_url}}">opt out</a>',
  });
  const stored = get(db, 'SELECT body, body_html FROM campaigns WHERE id = ?', id);
  assert.doesNotMatch(stored.body_html, /script|onclick|javascript:/i);
  assert.match(stored.body, /Read the notice \(https:\/\/lodge\.org\/a\?b=1&c=2\)/);
  startCampaign(db, id);
  const fake = fakeProviders();
  await processQueue(db, { sms: fake.smsProvider, email: fake.emailProvider, publicBaseUrl: PUBLIC, smsPerTick: 10, emailPerTick: 10 });
  const msg = fake.email[0];
  assert.match(msg.html, /<h2>Hello &lt;i&gt;Ann&lt;\/i&gt;<\/h2>/, 'merged values are escaped');
  assert.match(msg.html, /href="https:\/\/crm\.example\.org\/unsubscribe\/[^"]+"/, 'unsubscribe merge field works in links');
});
