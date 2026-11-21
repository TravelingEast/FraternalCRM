import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, seedValley, seedUser } from './helpers.js';
import { validateTwilioSignature } from '../src/providers/sms.js';
import crypto from 'node:crypto';

let env;
const PASS = 'correct-horse-battery';

before(async () => {
  env = await startServer({ config: { smsProvider: 'twilio' } });
  env.valleyA = seedValley(env.db, 'Valley Alpha');
  env.valleyB = seedValley(env.db, 'Valley Beta');
  seedUser(env.db, { email: 'orient@example.org', role: 'super_admin', password: PASS });
  seedUser(env.db, { email: 'alpha@example.org', role: 'valley_admin', valleyId: env.valleyA, password: PASS });
});
after(async () => { await env.close(); });

test('login is required and wrong passwords are refused', async () => {
  const c = client(env.base);
  assert.equal((await c.request('/api/me')).status, 401);
  assert.equal((await c.login('orient@example.org', 'wrong-password-here')).status, 401);
  const ok = await c.login('orient@example.org', PASS);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'super_admin');
  assert.equal(ok.data.user.password_hash, undefined);
});

test('valley admins see only their own valley', async () => {
  const alpha = client(env.base);
  await alpha.login('alpha@example.org', PASS);
  const created = await alpha.request('/api/contacts', { method: 'POST', body: { first_name: 'Ann', email: 'ann@alpha.org' } });
  assert.equal(created.status, 201);
  const beta = await seedContactIn(env.db, env.valleyB, 'beta@beta.org');

  const list = await alpha.request(`/api/contacts?valley_id=${env.valleyB}`);
  assert.equal(list.status, 403, 'naming another valley is refused, not silently redirected');
  const own = await alpha.request('/api/contacts');
  assert.equal(own.data.total, 1);
  assert.equal(own.data.rows[0].email, 'ann@alpha.org');

  const forbidden = await alpha.request(`/api/contacts/${beta}`);
  assert.equal(forbidden.status, 404, 'cross-valley record access returns 404');
  const mismatch = await alpha.request(`/api/valleys`);
  assert.deepEqual(mismatch.data.valleys.map((v) => v.id), [env.valleyA]);
});

test('valley admins cannot create users or valleys', async () => {
  const alpha = client(env.base);
  await alpha.login('alpha@example.org', PASS);
  assert.equal((await alpha.request('/api/valleys', { method: 'POST', body: { name: 'Nope' } })).status, 403);
  assert.equal((await alpha.request('/api/users', { method: 'POST', body: {} })).status, 403);
});

test('statewide admin creates a valley, a valley admin, and sees all valleys in stats', async () => {
  const orient = client(env.base);
  await orient.login('orient@example.org', PASS);
  const valley = await orient.request('/api/valleys', { method: 'POST', body: { name: 'Gamma Valley', city: 'Gamma' } });
  assert.equal(valley.status, 201);
  const user = await orient.request('/api/users', {
    method: 'POST',
    body: { email: 'gamma@example.org', name: 'Gamma Admin', password: PASS, role: 'valley_admin', valley_id: valley.data.id },
  });
  assert.equal(user.status, 201);
  const short = await orient.request('/api/users', { method: 'POST', body: { email: 'x@example.org', name: 'X', password: 'short', role: 'valley_admin', valley_id: valley.data.id } });
  assert.equal(short.status, 400);
  const stats = await orient.request('/api/stats');
  assert.equal(stats.data.valleys.length, 3);
});

test('CSV import over HTTP needs text/csv and returns a summary', async () => {
  const alpha = client(env.base);
  await alpha.login('alpha@example.org', PASS);
  const wrong = await alpha.request('/api/contacts/import', { method: 'POST', body: { x: 1 } });
  assert.equal(wrong.status, 415);
  const csv = 'First,Last,Email,Phone\nJo,Park,jo@alpha.org,555-444-3333\n';
  const res = await alpha.request('/api/contacts/import?consent_email=1', { method: 'POST', rawBody: csv, contentType: 'text/csv' });
  assert.equal(res.status, 200);
  assert.equal(res.data.created, 1);
  const exp = await alpha.request('/api/contacts/export');
  assert.equal(exp.status, 200);
  assert.match(exp.text, /jo@alpha\.org/);
});

test('campaign flow: create list, add members, send now, then see per-message status', async () => {
  const alpha = client(env.base);
  await alpha.login('alpha@example.org', PASS);
  const list = await alpha.request('/api/lists', { method: 'POST', body: { name: 'Members' } });
  const members = await alpha.request(`/api/lists/${list.data.id}/members`, {
    method: 'POST',
    body: { contact_ids: (await alpha.request('/api/contacts')).data.rows.map((r) => r.id) },
  });
  assert.equal(members.data.added, 2);
  const campaign = await alpha.request('/api/campaigns', {
    method: 'POST',
    body: { name: 'Lodge news', channel: 'email', subject: 'News', body: 'Hello', list_id: list.data.id, send_now: true },
  });
  assert.equal(campaign.status, 201);
  assert.equal(campaign.data.campaign.status, 'sending');
  const sent = await alpha.request(`/api/campaigns/${campaign.data.campaign.id}/messages`);
  assert.equal(sent.data.messages.length, 2);
});

test('valley admins cannot launch or read other valleys campaigns', async () => {
  const betaCampaign = Number(env.db.prepare(
    "INSERT INTO campaigns (valley_id, name, channel, subject, body, status, created_at) VALUES (?, 'B', 'sms', '', 'hi', 'draft', 'now')",
  ).run(env.valleyB).lastInsertRowid);
  const alpha = client(env.base);
  await alpha.login('alpha@example.org', PASS);
  assert.equal((await alpha.request(`/api/campaigns/${betaCampaign}`)).status, 404);
  assert.equal((await alpha.request(`/api/campaigns/${betaCampaign}/send`, { method: 'POST' })).status, 404);
});

test('API key authenticates the v1 endpoints for its valley only', async () => {
  const alpha = client(env.base);
  await alpha.login('alpha@example.org', PASS);
  const key = await alpha.request('/api/api-keys', { method: 'POST', body: { label: 'Membership database' } });
  assert.equal(key.status, 201);
  assert.match(key.data.key, /^frc_/);

  const bearer = { Authorization: `Bearer ${key.data.key}` };
  const anon = await fetch(`${env.base}/api/v1/contacts`);
  assert.equal(anon.status, 401);

  const up = await fetch(`${env.base}/api/v1/contacts`, {
    method: 'POST',
    headers: { ...bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ first_name: 'Sam', email: 'Sam@Alpha.org', phone: '5550005555', sms_opt_in: true, list_ids: [] }),
  });
  assert.equal(up.status, 201);
  const body = await up.json();
  assert.deepEqual(body.consent, { sms: 'granted' });

  const again = await fetch(`${env.base}/api/v1/contacts`, {
    method: 'POST', headers: { ...bearer, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'sam@alpha.org' }),
  });
  assert.equal((await again.json()).action, 'matched');

  const revoke = await alpha.request(`/api/api-keys/${key.data.id}`, { method: 'DELETE' });
  assert.equal(revoke.status, 200);
  const after = await fetch(`${env.base}/api/v1/contacts`, { headers: bearer });
  assert.equal(after.status, 401);
});

test('Twilio STOP webhook suppresses the number everywhere, and requires a valid signature', async () => {
  const phone = '+15557778888';
  env.db.prepare("INSERT INTO contacts (valley_id, phone, sms_opt_in, unsub_token, created_at, updated_at) VALUES (?, ?, 1, 'tok-1', 'n', 'n')").run(env.valleyA, phone);
  env.db.prepare("INSERT INTO contacts (valley_id, phone, sms_opt_in, unsub_token, created_at, updated_at) VALUES (?, ?, 1, 'tok-2', 'n', 'n')").run(env.valleyB, phone);

  const params = { From: phone, Body: 'STOP' };
  const url = `${env.config.publicBaseUrl}/webhooks/twilio`;
  const badRes = await fetch(`${env.base}/webhooks/twilio`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'nope' }, body: new URLSearchParams(params),
  });
  assert.equal(badRes.status, 403);

  const sig = signTwilio('test-token', url, params);
  const res = await fetch(`${env.base}/webhooks/twilio`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig }, body: new URLSearchParams(params),
  });
  assert.equal(res.status, 200);
  const rows = env.db.prepare('SELECT sms_opt_in, sms_suppressed FROM contacts WHERE phone = ?').all(phone);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.deepEqual([r.sms_opt_in, r.sms_suppressed], [0, 1]);
});

test('unsubscribe link: GET shows a form and does not opt out; POST does', async () => {
  env.db.prepare("INSERT INTO contacts (valley_id, email, email_opt_in, unsub_token, created_at, updated_at) VALUES (?, 'unsub@alpha.org', 1, 'unsub-tok', 'n', 'n')").run(env.valleyA);
  const get1 = await fetch(`${env.base}/unsubscribe/unsub-tok`);
  assert.equal(get1.status, 200);
  assert.equal(env.db.prepare("SELECT email_suppressed FROM contacts WHERE unsub_token = 'unsub-tok'").get().email_suppressed, 0);
  const post = await fetch(`${env.base}/unsubscribe/unsub-tok`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(post.status, 200);
  assert.equal(env.db.prepare("SELECT email_suppressed, email_opt_in FROM contacts WHERE unsub_token = 'unsub-tok'").get().email_suppressed, 1);
});

test('admin cannot clear an opt-out, but can record one', async () => {
  const alpha = client(env.base);
  await alpha.login('alpha@example.org', PASS);
  const row = env.db.prepare("SELECT id FROM contacts WHERE unsub_token = 'unsub-tok'").get();
  const res = await alpha.request(`/api/contacts/${row.id}`, { method: 'PATCH', body: { email_opt_in: true } });
  assert.equal(res.status, 409);
});

test('Twilio signature helper matches the documented algorithm', () => {
  const params = { Body: 'hi', From: '+15550001111' };
  const sig = signTwilio('k', 'https://x.org/hook', params);
  assert.equal(validateTwilioSignature('k', 'https://x.org/hook', params, sig), true);
  assert.equal(validateTwilioSignature('k', 'https://x.org/hook', { ...params, Body: 'bye' }, sig), false);
});

function signTwilio(token, url, params) {
  let data = url;
  for (const k of Object.keys(params).sort()) data += k + params[k];
  return crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
}

async function seedContactIn(db, valleyId, email) {
  return Number(db.prepare("INSERT INTO contacts (valley_id, email, unsub_token, created_at, updated_at) VALUES (?, ?, ?, 'n', 'n')").run(valleyId, email, `t-${email}`).lastInsertRowid);
}

test('autosave flow over HTTP: create draft, patch it, schedule it, and it stops being editable', async () => {
  const alpha = client(env.base);
  await alpha.login('alpha@example.org', PASS);
  const created = await alpha.request('/api/campaigns', { method: 'POST', body: { draft: true, channel: 'email', name: '' } });
  assert.equal(created.status, 201);
  const id = created.data.campaign.id;
  const patched = await alpha.request(`/api/campaigns/${id}`, { method: 'PATCH', body: { name: 'Autosaved', subject: 'Hi', body_html: '<p>Body <script>x()</script></p>' } });
  assert.equal(patched.status, 200);
  assert.doesNotMatch(patched.data.campaign.body_html, /script/);
  const future = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await alpha.request(`/api/campaigns/${id}/schedule`, { method: 'POST', body: { scheduled_at: future } })).status, 200);
  assert.equal((await alpha.request(`/api/campaigns/${id}`, { method: 'PATCH', body: { name: 'late edit' } })).status, 409);
  const orient = client(env.base);
  await orient.login('orient@example.org', PASS);
  const betaDraft = await orient.request('/api/campaigns', { method: 'POST', body: { draft: true, valley_id: env.valleyB, channel: 'sms', name: 'beta draft' } });
  assert.equal((await alpha.request(`/api/campaigns/${betaDraft.data.campaign.id}`, { method: 'PATCH', body: { name: 'x' } })).status, 404);
});

// Last on purpose: it exhausts the login limiter for the shared test IP.
test('login rate limit blocks after repeated failures', async () => {
  const c = client(env.base);
  let last;
  for (let i = 0; i < 11; i++) last = await c.login('nobody@example.org', 'whatever-password');
  assert.equal(last.status, 429);
});
