import express from 'express';
import { all, get, run } from '../db.js';
import { HttpError } from '../errors.js';
import {
  canAccessValley, clearSessionCookie, createSession, destroySession, generateApiKey, hashPassword,
  loadForUser, publicUser, RateLimiter, requireAuth, requireSuper, resolveValley, setSessionCookie, verifyPassword,
} from '../auth.js';
import { addToList, assertList, contactsToCsv, contactWhere, importContacts, logConsent, normalizeEmail, normalizePhone, upsertContact } from '../contacts.js';
import { campaignView, cancelScheduled, createCampaign, deleteCampaign, startCampaign } from '../campaigns.js';
import { cleanText, flag, nowIso, optionalInt, str } from '../util.js';

const ROLES = ['super_admin', 'valley_admin'];
const CONTACT_COLS = `c.id, c.first_name, c.last_name, c.email, c.phone, c.email_opt_in, c.email_suppressed,
  c.sms_opt_in, c.sms_suppressed, c.notes, c.created_at, c.updated_at`;

export function visibleValleys(db, user) {
  if (user.role === 'super_admin') return all(db, 'SELECT id, name, city FROM valleys ORDER BY name');
  return all(db, 'SELECT id, name, city FROM valleys WHERE id = ?', user.valley_id);
}

function valleyStats(db, valleyId) {
  const valley = get(db, 'SELECT id, name, city FROM valleys WHERE id = ?', valleyId);
  const contacts = get(
    db,
    `SELECT COUNT(*) AS contacts,
            COALESCE(SUM(CASE WHEN email IS NOT NULL AND email_opt_in = 1 AND email_suppressed = 0 THEN 1 ELSE 0 END), 0) AS email_reachable,
            COALESCE(SUM(CASE WHEN phone IS NOT NULL AND sms_opt_in = 1 AND sms_suppressed = 0 THEN 1 ELSE 0 END), 0) AS sms_reachable
       FROM contacts WHERE valley_id = ?`,
    valleyId,
  );
  const campaigns = get(db, "SELECT COUNT(*) AS campaigns_sent FROM campaigns WHERE valley_id = ? AND status = 'sent'", valleyId);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const messages = get(
    db,
    `SELECT COUNT(*) AS sent_30d FROM messages m JOIN campaigns cp ON cp.id = m.campaign_id
      WHERE cp.valley_id = ? AND m.status = 'sent' AND m.sent_at >= ?`,
    valleyId, since,
  );
  return { ...valley, ...contacts, ...campaigns, ...messages };
}

function assertPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    throw new HttpError(400, 'Passwords must be at least 10 characters.');
  }
}

export function adminRouter({ db, config }) {
  const r = express.Router();
  const loginLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

  // --- Session ---------------------------------------------------------------

  r.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    if (loginLimiter.isLimited(ip)) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    const email = str(req.body?.email).toLowerCase();
    const user = email ? get(db, 'SELECT * FROM users WHERE email = ? AND active = 1', email) : undefined;
    if (!user || !verifyPassword(req.body?.password, user.password_hash)) {
      loginLimiter.fail(ip);
      throw new HttpError(401, 'Email or password is not correct.');
    }
    loginLimiter.clear(ip);
    run(db, 'DELETE FROM sessions WHERE expires_at < ?', nowIso());
    setSessionCookie(res, createSession(db, user.id), config);
    res.json({ user: publicUser(user) });
  });

  r.post('/logout', (req, res) => {
    destroySession(db, req.sessionToken);
    clearSessionCookie(res, config);
    res.json({ ok: true });
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user), valleys: visibleValleys(db, req.user), orient: config.orientName });
  });

  r.post('/me/password', requireAuth, (req, res) => {
    const user = get(db, 'SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(req.body?.current_password, user.password_hash)) throw new HttpError(400, 'Current password is not correct.');
    assertPassword(req.body?.new_password);
    run(db, 'UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(req.body.new_password), req.user.id);
    run(db, 'DELETE FROM sessions WHERE user_id = ?', req.user.id);
    setSessionCookie(res, createSession(db, req.user.id), config);
    res.json({ ok: true });
  });

  // --- Valleys and users (statewide) ------------------------------------------

  r.get('/valleys', requireAuth, (req, res) => res.json({ valleys: visibleValleys(db, req.user) }));

  r.post('/valleys', requireAuth, requireSuper, (req, res) => {
    const name = cleanText(req.body?.name, 120);
    if (!name) throw new HttpError(400, 'Valley name is required.');
    const info = run(db, 'INSERT INTO valleys (name, city, created_at) VALUES (?, ?, ?)', name, cleanText(req.body?.city, 120), nowIso());
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.patch('/valleys/:id', requireAuth, requireSuper, (req, res) => {
    const id = optionalInt(req.params.id);
    if (!id || !get(db, 'SELECT id FROM valleys WHERE id = ?', id)) throw new HttpError(404, 'Valley not found');
    const name = cleanText(req.body?.name, 120);
    if (name) run(db, 'UPDATE valleys SET name = ? WHERE id = ?', name, id);
    if (typeof req.body?.city === 'string') run(db, 'UPDATE valleys SET city = ? WHERE id = ?', cleanText(req.body.city, 120), id);
    res.json({ ok: true });
  });

  r.get('/users', requireAuth, requireSuper, (req, res) => {
    res.json({
      users: all(
        db,
        `SELECT u.id, u.email, u.name, u.role, u.valley_id, u.active, u.created_at, v.name AS valley_name
           FROM users u LEFT JOIN valleys v ON v.id = u.valley_id
          ORDER BY u.role, v.name, u.name`,
      ),
    });
  });

  r.post('/users', requireAuth, requireSuper, (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const name = cleanText(req.body?.name, 120);
    const role = req.body?.role;
    if (!email) throw new HttpError(400, 'Enter a valid email address.');
    if (!name) throw new HttpError(400, 'Name is required.');
    if (!ROLES.includes(role)) throw new HttpError(400, 'Choose a role.');
    assertPassword(req.body?.password);
    let valleyId = null;
    if (role === 'valley_admin') {
      valleyId = optionalInt(req.body?.valley_id);
      if (!valleyId || !get(db, 'SELECT id FROM valleys WHERE id = ?', valleyId)) throw new HttpError(400, 'Choose the valley this admin manages.');
    }
    const info = run(
      db,
      'INSERT INTO users (email, name, password_hash, role, valley_id, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      email, name, hashPassword(req.body.password), role, valleyId, nowIso(),
    );
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  });

  r.patch('/users/:id', requireAuth, requireSuper, (req, res) => {
    const id = optionalInt(req.params.id);
    const user = id ? get(db, 'SELECT id FROM users WHERE id = ?', id) : undefined;
    if (!user) throw new HttpError(404, 'User not found');
    const sets = [];
    const params = [];
    if (typeof req.body?.active === 'boolean') {
      if (id === req.user.id && !req.body.active) throw new HttpError(400, 'You cannot disable your own account.');
      sets.push('active = ?');
      params.push(req.body.active ? 1 : 0);
      if (!req.body.active) run(db, 'DELETE FROM sessions WHERE user_id = ?', id);
    }
    if (req.body?.password !== undefined) {
      assertPassword(req.body.password);
      sets.push('password_hash = ?');
      params.push(hashPassword(req.body.password));
      run(db, 'DELETE FROM sessions WHERE user_id = ?', id);
    }
    const name = cleanText(req.body?.name, 120);
    if (name) {
      sets.push('name = ?');
      params.push(name);
    }
    if (sets.length) run(db, `UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    res.json({ ok: true });
  });

  // --- Stats -----------------------------------------------------------------

  r.get('/stats', requireAuth, (req, res) => {
    if (req.user.role === 'valley_admin' || req.query.valley_id) {
      res.json({ valley: valleyStats(db, resolveValley(db, req)) });
    } else {
      res.json({ valleys: visibleValleys(db, req.user).map((v) => valleyStats(db, v.id)) });
    }
  });

  // --- Contacts ----------------------------------------------------------------

  r.get('/contacts', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    const listId = optionalInt(req.query.list_id);
    if (listId) assertList(db, listId, valleyId);
    const q = cleanText(req.query.q, 100) || null;
    const limit = Math.min(optionalInt(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { where, params } = contactWhere({ valleyId, listId, q });
    const { n } = get(db, `SELECT COUNT(*) AS n FROM contacts c WHERE ${where}`, ...params);
    const rows = all(
      db,
      `SELECT ${CONTACT_COLS} FROM contacts c WHERE ${where} ORDER BY c.last_name, c.first_name, c.id LIMIT ? OFFSET ?`,
      ...params, limit, offset,
    );
    res.json({ total: n, rows });
  });

  r.get('/contacts/export', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    const listId = optionalInt(req.query.list_id);
    if (listId) assertList(db, listId, valleyId);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contacts-${stamp}.csv"`);
    res.send(contactsToCsv(db, valleyId, listId));
  });

  r.get('/contacts/:id', requireAuth, (req, res) => {
    const contact = loadForUser(db, req, 'contacts', optionalInt(req.params.id));
    const log = all(
      db,
      'SELECT channel, action, source, created_at FROM consent_log WHERE contact_id = ? ORDER BY id DESC LIMIT 50',
      contact.id,
    );
    const lists = all(
      db,
      'SELECT l.id, l.name FROM list_members m JOIN lists l ON l.id = m.list_id WHERE m.contact_id = ? ORDER BY l.name',
      contact.id,
    );
    res.json({
      contact: { ...get(db, `SELECT ${CONTACT_COLS} FROM contacts c WHERE c.id = ?`, contact.id) },
      consent_log: log,
      lists,
    });
  });

  r.post('/contacts', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    const body = req.body || {};
    const result = upsertContact(db, valleyId, body, { source: `admin:${req.user.id}` });
    if (result.action === 'skipped') throw new HttpError(400, [result.reason, ...result.warnings].join('; '));
    const listId = optionalInt(body.list_id);
    if (listId) {
      assertList(db, listId, valleyId);
      addToList(db, listId, [result.id]);
    }
    res.status(result.action === 'created' ? 201 : 200).json({ ...result, warnings: result.warnings });
  });

  r.patch('/contacts/:id', requireAuth, (req, res) => {
    const contact = loadForUser(db, req, 'contacts', optionalInt(req.params.id));
    const b = req.body || {};
    const source = `admin:${req.user.id}`;
    const updates = {};
    for (const field of ['first_name', 'last_name']) {
      if (typeof b[field] === 'string') updates[field] = cleanText(b[field], 120);
    }
    if (typeof b.notes === 'string') updates.notes = cleanText(b.notes, 5000);
    if ('email' in b) {
      const email = b.email ? normalizeEmail(b.email) : null;
      if (b.email && !email) throw new HttpError(400, 'Enter a valid email address.');
      updates.email = email;
    }
    if ('phone' in b) {
      const phone = b.phone ? normalizePhone(b.phone) : null;
      if (b.phone && !phone) throw new HttpError(400, 'Enter a valid phone number, with area code.');
      updates.phone = phone;
    }
    for (const ch of ['email', 'sms']) {
      const optKey = `${ch}_opt_in`;
      const suppressedKey = `${ch}_suppressed`;
      if (typeof b[optKey] === 'boolean') {
        if (b[optKey]) {
          if (contact[suppressedKey] === 1) throw new HttpError(409, 'This person opted out. Only they can opt back in.');
          if (contact[optKey] !== 1) {
            updates[optKey] = 1;
            logConsent(db, contact.id, ch, 'opt_in', source);
          }
        } else if (contact[optKey] === 1) {
          updates[optKey] = 0;
          logConsent(db, contact.id, ch, 'opt_out', source);
        }
      }
      // Admins can record an opt-out someone asked for, but cannot clear one.
      if (b[suppressedKey] === true && contact[suppressedKey] !== 1) {
        updates[suppressedKey] = 1;
        updates[optKey] = 0;
        logConsent(db, contact.id, ch, 'opt_out', source);
      }
    }
    const keys = Object.keys(updates);
    if (keys.length) {
      run(
        db,
        `UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        ...keys.map((k) => updates[k]), nowIso(), contact.id,
      );
    }
    res.json({ ok: true });
  });

  r.delete('/contacts/:id', requireAuth, (req, res) => {
    const contact = loadForUser(db, req, 'contacts', optionalInt(req.params.id));
    run(db, 'DELETE FROM contacts WHERE id = ?', contact.id);
    res.json({ ok: true });
  });

  // Import: send the file as text/csv. Consent checkboxes are sent as query flags and apply to every row that has an address.
  r.post('/contacts/import', requireAuth, express.text({ type: 'text/csv', limit: '10mb' }), (req, res) => {
    const valleyId = resolveValley(db, req);
    if (typeof req.body !== 'string') throw new HttpError(415, 'Send the file as text/csv.');
    const listId = optionalInt(req.query.list_id);
    if (listId) assertList(db, listId, valleyId);
    const summary = importContacts(db, valleyId, req.body, {
      listId,
      consentEmail: flag(req.query.consent_email),
      consentSms: flag(req.query.consent_sms),
      source: `import:${req.user.id}`,
    });
    res.json(summary);
  });

  // --- Lists ---------------------------------------------------------------------

  r.get('/lists', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    res.json({
      lists: all(
        db,
        `SELECT l.id, l.name, l.created_at, (SELECT COUNT(*) FROM list_members m WHERE m.list_id = l.id) AS members
           FROM lists l WHERE l.valley_id = ? ORDER BY l.name`,
        valleyId,
      ),
    });
  });

  r.post('/lists', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    const name = cleanText(req.body?.name, 120);
    if (!name) throw new HttpError(400, 'List name is required.');
    try {
      const info = run(db, 'INSERT INTO lists (valley_id, name, created_at) VALUES (?, ?, ?)', valleyId, name, nowIso());
      res.status(201).json({ id: Number(info.lastInsertRowid) });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'A list with that name already exists.');
      throw err;
    }
  });

  r.delete('/lists/:id', requireAuth, (req, res) => {
    const list = loadForUser(db, req, 'lists', optionalInt(req.params.id));
    const { n } = get(
      db,
      "SELECT COUNT(*) AS n FROM campaigns WHERE list_id = ? AND status IN ('draft', 'scheduled', 'sending')",
      list.id,
    );
    if (n > 0) throw new HttpError(409, 'A draft or scheduled campaign uses this list. Delete or cancel it first.');
    run(db, 'DELETE FROM lists WHERE id = ?', list.id);
    res.json({ ok: true });
  });

  r.post('/lists/:id/members', requireAuth, (req, res) => {
    const list = loadForUser(db, req, 'lists', optionalInt(req.params.id));
    const ids = Array.isArray(req.body?.contact_ids) ? req.body.contact_ids.map(optionalInt).filter(Boolean) : [];
    if (!ids.length) throw new HttpError(400, 'Choose at least one contact.');
    res.json({ added: addToList(db, list.id, ids) });
  });

  r.delete('/lists/:id/members/:contactId', requireAuth, (req, res) => {
    const list = loadForUser(db, req, 'lists', optionalInt(req.params.id));
    run(db, 'DELETE FROM list_members WHERE list_id = ? AND contact_id = ?', list.id, optionalInt(req.params.contactId));
    res.json({ ok: true });
  });

  // --- Campaigns -------------------------------------------------------------------

  r.get('/campaigns', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    const rows = all(
      db,
      `SELECT cp.id, cp.name, cp.channel, cp.status, cp.scheduled_at, cp.created_at, cp.sent_at, l.name AS list_name,
              (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = cp.id) AS recipients,
              (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = cp.id AND m.status = 'sent') AS sent,
              (SELECT COUNT(*) FROM messages m WHERE m.campaign_id = cp.id AND m.status = 'failed') AS failed
         FROM campaigns cp LEFT JOIN lists l ON l.id = cp.list_id
        WHERE cp.valley_id = ? ORDER BY cp.created_at DESC LIMIT 200`,
      valleyId,
    );
    res.json({ campaigns: rows });
  });

  r.post('/campaigns', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    const id = createCampaign(db, valleyId, req.user.id, req.body || {});
    if (req.body?.send_now === true) startCampaign(db, id);
    res.status(201).json({ campaign: campaignView(db, id) });
  });

  r.get('/campaigns/:id', requireAuth, (req, res) => {
    const campaign = loadForUser(db, req, 'campaigns', optionalInt(req.params.id));
    res.json({ campaign: campaignView(db, campaign.id) });
  });

  r.post('/campaigns/:id/send', requireAuth, (req, res) => {
    const campaign = loadForUser(db, req, 'campaigns', optionalInt(req.params.id));
    res.json({ campaign: startCampaign(db, campaign.id) });
  });

  r.post('/campaigns/:id/cancel', requireAuth, (req, res) => {
    const campaign = loadForUser(db, req, 'campaigns', optionalInt(req.params.id));
    cancelScheduled(db, campaign.id);
    res.json({ campaign: campaignView(db, campaign.id) });
  });

  r.delete('/campaigns/:id', requireAuth, (req, res) => {
    const campaign = loadForUser(db, req, 'campaigns', optionalInt(req.params.id));
    deleteCampaign(db, campaign.id);
    res.json({ ok: true });
  });

  r.get('/campaigns/:id/messages', requireAuth, (req, res) => {
    const campaign = loadForUser(db, req, 'campaigns', optionalInt(req.params.id));
    const status = ['pending', 'sent', 'failed', 'skipped'].includes(req.query.status) ? req.query.status : null;
    res.json({
      messages: all(
        db,
        `SELECT m.id, m.status, m.reason, m.to_address, m.sent_at, c.first_name, c.last_name
           FROM messages m JOIN contacts c ON c.id = m.contact_id
          WHERE m.campaign_id = ? AND (? IS NULL OR m.status = ?)
          ORDER BY m.id LIMIT 500`,
        campaign.id, status, status,
      ),
    });
  });

  // --- API keys ----------------------------------------------------------------------

  r.get('/api-keys', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    res.json({
      keys: all(db, 'SELECT id, label, created_at, last_used_at, revoked_at FROM api_keys WHERE valley_id = ? ORDER BY id DESC', valleyId),
    });
  });

  r.post('/api-keys', requireAuth, (req, res) => {
    const valleyId = resolveValley(db, req);
    const label = cleanText(req.body?.label, 80);
    if (!label) throw new HttpError(400, 'Give the key a label, such as "Membership database".');
    const { key, hash } = generateApiKey();
    const info = run(db, 'INSERT INTO api_keys (valley_id, label, key_hash, created_at) VALUES (?, ?, ?, ?)', valleyId, label, hash, nowIso());
    // The full key is returned once. Only its hash is stored.
    res.status(201).json({ id: Number(info.lastInsertRowid), label, key });
  });

  r.delete('/api-keys/:id', requireAuth, (req, res) => {
    const row = get(db, 'SELECT id, valley_id FROM api_keys WHERE id = ?', optionalInt(req.params.id));
    if (!row || !canAccessValley(req.user, row.valley_id)) throw new HttpError(404, 'Key not found');
    run(db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', nowIso(), row.id);
    res.json({ ok: true });
  });

  return r;
}
