import express from 'express';
import { all, get } from '../db.js';
import { HttpError } from '../errors.js';
import { apiKeyAuth } from '../auth.js';
import { addToList, assertList, normalizeEmail, upsertContact } from '../contacts.js';
import { campaignView, createCampaign, startCampaign } from '../campaigns.js';
import { cleanText, nowIso, optionalInt } from '../util.js';

// Machine-to-machine API, authenticated with a valley-scoped key: Authorization: Bearer frc_...
export function v1Router({ db }) {
  const r = express.Router();
  r.use(apiKeyAuth(db));
  const valleyId = (req) => req.apiValleyId;

  r.get('/lists', (req, res) => {
    res.json({
      data: all(db, 'SELECT id, name FROM lists WHERE valley_id = ? ORDER BY name', valleyId(req)),
    });
  });

  r.post('/lists', (req, res) => {
    const name = cleanText(req.body?.name, 120);
    if (!name) throw new HttpError(400, 'name is required');
    const existing = get(db, 'SELECT id FROM lists WHERE valley_id = ? AND name = ?', valleyId(req), name);
    if (existing) return res.json({ id: existing.id, created: false });
    const info = db.prepare('INSERT INTO lists (valley_id, name, created_at) VALUES (?, ?, ?)').run(valleyId(req), name, nowIso());
    res.status(201).json({ id: Number(info.lastInsertRowid), created: true });
  });

  r.get('/contacts', (req, res) => {
    const afterId = optionalInt(req.query.after_id) || 0;
    const limit = Math.min(optionalInt(req.query.limit) || 100, 500);
    const data = all(
      db,
      `SELECT id, first_name, last_name, email, phone, email_opt_in, email_suppressed, sms_opt_in, sms_suppressed, created_at
         FROM contacts WHERE valley_id = ? AND id > ? ORDER BY id LIMIT ?`,
      valleyId(req), afterId, limit,
    );
    res.json({ data, next_after_id: data.length === limit ? data[data.length - 1].id : null });
  });

  // Create or match a contact. Set email_opt_in or sms_opt_in to true only when the person has agreed to that channel.
  // Opt-outs are never reversed by this endpoint.
  r.post('/contacts', (req, res) => {
    const body = req.body || {};
    const result = upsertContact(db, valleyId(req), body, { source: `api:key:${req.apiKey.id}` });
    if (result.action === 'skipped') throw new HttpError(400, result.reason);
    if (Array.isArray(body.list_ids)) {
      for (const listId of body.list_ids.map(optionalInt).filter(Boolean)) {
        assertList(db, listId, valleyId(req));
        addToList(db, listId, [result.id]);
      }
    }
    res.status(result.action === 'created' ? 201 : 200).json({ id: result.id, action: result.action, consent: result.consent, warnings: result.warnings });
  });

  // Add existing contacts to a list by id or email.
  r.post('/lists/:id/members', (req, res) => {
    const listId = optionalInt(req.params.id);
    assertList(db, listId, valleyId(req));
    const ids = (Array.isArray(req.body?.contact_ids) ? req.body.contact_ids : []).map(optionalInt).filter(Boolean);
    const emails = (Array.isArray(req.body?.emails) ? req.body.emails : []).map(normalizeEmail).filter(Boolean);
    for (const email of emails) {
      const row = get(db, 'SELECT id FROM contacts WHERE valley_id = ? AND email = ?', valleyId(req), email);
      if (row) ids.push(row.id);
    }
    res.json({ added: addToList(db, listId, ids) });
  });

  r.post('/campaigns', (req, res) => {
    const body = req.body || {};
    const id = createCampaign(db, valleyId(req), null, body);
    if (body.send_now === true) startCampaign(db, id);
    res.status(201).json({ campaign: campaignView(db, id) });
  });

  r.get('/campaigns/:id', (req, res) => {
    const row = get(db, 'SELECT valley_id FROM campaigns WHERE id = ?', optionalInt(req.params.id));
    if (!row || row.valley_id !== valleyId(req)) throw new HttpError(404, 'Campaign not found');
    res.json({ campaign: campaignView(db, optionalInt(req.params.id)) });
  });

  r.post('/campaigns/:id/send', (req, res) => {
    const row = get(db, 'SELECT valley_id FROM campaigns WHERE id = ?', optionalInt(req.params.id));
    if (!row || row.valley_id !== valleyId(req)) throw new HttpError(404, 'Campaign not found');
    res.json({ campaign: startCampaign(db, optionalInt(req.params.id)) });
  });

  return r;
}
