import express from 'express';
import { all, get, run, tx } from '../db.js';
import { validateTwilioSignature } from '../providers/sms.js';
import { logConsent, normalizePhone } from '../contacts.js';
import { escapeHtml, nowIso } from '../util.js';

const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const START_WORDS = new Set(['START', 'UNSTOP']);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font-family:Georgia,serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1a1a1a;line-height:1.5}
button{font:inherit;padding:10px 18px;border:0;border-radius:4px;background:#1f3a5f;color:#fff;cursor:pointer}</style>
</head><body>${body}</body></html>`;
}

// Opts a phone number out of texts for every contact that uses it, across all valleys.
function setSmsSuppressed(db, phone, suppressed, source) {
  tx(db, () => {
    for (const c of all(db, 'SELECT id, sms_suppressed FROM contacts WHERE phone = ?', phone)) {
      if (suppressed && c.sms_suppressed === 0) {
        run(db, 'UPDATE contacts SET sms_suppressed = 1, sms_opt_in = 0, updated_at = ? WHERE id = ?', nowIso(), c.id);
        logConsent(db, c.id, 'sms', 'opt_out', source);
      } else if (!suppressed && c.sms_suppressed === 1) {
        run(db, 'UPDATE contacts SET sms_suppressed = 0, sms_opt_in = 1, updated_at = ? WHERE id = ?', nowIso(), c.id);
        logConsent(db, c.id, 'sms', 'opt_in', source);
      }
    }
  });
}

export function publicRouter({ db, config }) {
  const r = express.Router();

  // Unsubscribe page. GET shows a confirm button so email scanners that pre-fetch links do not opt people out.
  r.get('/unsubscribe/:token', (req, res) => {
    const contact = get(
      db,
      `SELECT v.name AS valley_name FROM contacts c JOIN valleys v ON v.id = c.valley_id WHERE c.unsub_token = ?`,
      req.params.token,
    );
    if (!contact) return res.status(404).type('html').send(page('Not found', '<p>This link is no longer valid.</p>'));
    res.type('html').send(page('Unsubscribe', `
      <h1>Unsubscribe</h1>
      <p>Stop receiving email from <strong>${escapeHtml(contact.valley_name)}</strong>?</p>
      <form method="post"><button type="submit">Unsubscribe me</button></form>`));
  });

  // POST handles both the confirm button and RFC 8058 one-click unsubscribe from mail clients.
  r.post('/unsubscribe/:token', express.urlencoded({ extended: false }), (req, res) => {
    const contact = get(db, 'SELECT id, email_opt_in FROM contacts WHERE unsub_token = ?', req.params.token);
    if (!contact) return res.status(404).type('html').send(page('Not found', '<p>This link is no longer valid.</p>'));
    run(
      db,
      'UPDATE contacts SET email_suppressed = 1, email_opt_in = 0, updated_at = ? WHERE id = ?',
      nowIso(), contact.id,
    );
    if (contact.email_opt_in === 1) logConsent(db, contact.id, 'email', 'opt_out', 'unsubscribe link');
    res.type('html').send(page('Unsubscribed', '<h1>You are unsubscribed</h1><p>You will no longer receive these emails.</p>'));
  });

  // Twilio inbound webhook. Only active when SMS_PROVIDER=twilio, and every request must carry a valid signature.
  r.post('/webhooks/twilio', express.urlencoded({ extended: false }), (req, res) => {
    if (config.smsProvider !== 'twilio') return res.status(404).end();
    const signature = req.get('X-Twilio-Signature') || '';
    const url = `${config.publicBaseUrl}/webhooks/twilio`;
    if (!validateTwilioSignature(config.twilio.authToken, url, req.body, signature)) {
      return res.status(403).type('text').send('Invalid signature');
    }

    const from = normalizePhone(req.body.From);
    const word = String(req.body.Body || '').trim().toUpperCase();
    let reply = '';
    if (from && STOP_WORDS.has(word)) setSmsSuppressed(db, from, true, 'sms STOP');
    else if (from && START_WORDS.has(word)) setSmsSuppressed(db, from, false, 'sms START');
    else if (from && word === 'HELP') reply = 'Reply STOP to unsubscribe from texts from this number.';

    const twiml = reply ? `<Message>${escapeHtml(reply)}</Message>` : '';
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${twiml}</Response>`);
  });

  return r;
}
