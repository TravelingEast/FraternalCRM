import { all, get, run, tx } from './db.js';
import { HttpError } from './errors.js';
import { assertList } from './contacts.js';
import { htmlToText, sanitizeEmailHtml } from './html.js';
import { escapeHtml, nowIso, optionalInt, str } from './util.js';

const CHANNELS = ['email', 'sms'];
const SMS_MAX = 1600;
const BODY_MAX = 20000;

export function createCampaign(db, valleyId, userId, input = {}) {
  const name = str(input.name).slice(0, 120);
  const channel = input.channel;
  const subject = str(input.subject).replace(/[\r\n]+/g, ' ').slice(0, 200);
  let body = str(input.body);
  // Email campaigns may carry rich HTML from the editor. It is sanitised, and the plain-text part is derived from it.
  let bodyHtml = '';
  if (channel === 'email' && typeof input.body_html === 'string' && input.body_html.trim()) {
    if (input.body_html.length > 200000) throw new HttpError(400, 'The message is too large.');
    bodyHtml = sanitizeEmailHtml(input.body_html);
    body = htmlToText(bodyHtml);
  }

  if (!name) throw new HttpError(400, 'Give the campaign a name.');
  if (!CHANNELS.includes(channel)) throw new HttpError(400, 'Channel must be "email" or "sms".');
  if (!body) throw new HttpError(400, 'The message is empty.');
  if (body.length > BODY_MAX) throw new HttpError(400, 'The message is too long.');
  if (channel === 'sms' && body.length > SMS_MAX) throw new HttpError(400, `Text messages are limited to ${SMS_MAX} characters.`);
  if (channel === 'email' && !subject) throw new HttpError(400, 'Email campaigns need a subject line.');

  // A missing or null list_id means "all contacts in the valley". Any other bad value is rejected rather than silently widening the audience.
  let listId = null;
  if (input.list_id !== undefined && input.list_id !== null && input.list_id !== '') {
    listId = optionalInt(input.list_id);
    if (!listId) throw new HttpError(400, 'Choose a valid list or "All contacts".');
    assertList(db, listId, valleyId);
  }

  let scheduledAt = null;
  if (input.scheduled_at) {
    const when = new Date(input.scheduled_at);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      throw new HttpError(400, 'The scheduled time must be in the future.');
    }
    scheduledAt = when.toISOString();
  }

  const info = run(
    db,
    `INSERT INTO campaigns (valley_id, name, channel, subject, body, body_html, list_id, status, scheduled_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    valleyId, name, channel, subject, body, bodyHtml, listId, scheduledAt ? 'scheduled' : 'draft', scheduledAt, userId ?? null, nowIso(),
  );
  return Number(info.lastInsertRowid);
}

export function campaignView(db, id) {
  const c = get(
    db,
    `SELECT cp.*, l.name AS list_name FROM campaigns cp LEFT JOIN lists l ON l.id = cp.list_id WHERE cp.id = ?`,
    id,
  );
  if (!c) return null;
  const counts = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const row of all(db, 'SELECT status, COUNT(*) AS n FROM messages WHERE campaign_id = ? GROUP BY status', id)) {
    counts[row.status] = row.n;
  }
  return { ...c, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

export function isEligible(contact, channel) {
  if (channel === 'email') return !!contact.email && contact.email_opt_in === 1 && contact.email_suppressed === 0;
  return !!contact.phone && contact.sms_opt_in === 1 && contact.sms_suppressed === 0;
}

// Snapshots the audience when a campaign starts. Ineligible people are recorded as skipped, so the counts explain themselves.
function prepareRecipients(db, campaign) {
  const contacts = all(
    db,
    `SELECT c.id, c.email, c.phone, c.email_opt_in, c.email_suppressed, c.sms_opt_in, c.sms_suppressed
       FROM contacts c
      WHERE c.valley_id = ?
        AND (? IS NULL OR c.id IN (SELECT contact_id FROM list_members WHERE list_id = ?))`,
    campaign.valley_id, campaign.list_id, campaign.list_id,
  );
  const addressField = campaign.channel === 'email' ? 'email' : 'phone';
  for (const contact of contacts) {
    const address = contact[addressField];
    let status = 'pending';
    let reason = null;
    if (!address) {
      status = 'skipped';
      reason = `no ${addressField}`;
    } else if (!isEligible(contact, campaign.channel)) {
      status = 'skipped';
      const suppressed = campaign.channel === 'email' ? contact.email_suppressed : contact.sms_suppressed;
      reason = suppressed ? 'opted out' : 'not opted in';
    }
    run(
      db,
      `INSERT OR IGNORE INTO messages (campaign_id, contact_id, channel, to_address, status, reason) VALUES (?, ?, ?, ?, ?, ?)`,
      campaign.id, contact.id, campaign.channel, address || null, status, reason,
    );
  }
}

export function startCampaign(db, id) {
  return tx(db, () => {
    const campaign = get(db, 'SELECT * FROM campaigns WHERE id = ?', id);
    if (!campaign) throw new HttpError(404, 'Campaign not found');
    if (!['draft', 'scheduled'].includes(campaign.status)) throw new HttpError(409, 'This campaign has already started');
    prepareRecipients(db, campaign);
    const { n } = get(db, "SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ? AND status = 'pending'", id);
    const ts = nowIso();
    if (n > 0) {
      run(db, "UPDATE campaigns SET status = 'sending', started_at = ? WHERE id = ?", ts, id);
    } else {
      run(db, "UPDATE campaigns SET status = 'sent', started_at = ?, sent_at = ? WHERE id = ?", ts, ts, id);
    }
    return campaignView(db, id);
  });
}

export function cancelScheduled(db, id) {
  const campaign = get(db, 'SELECT status FROM campaigns WHERE id = ?', id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');
  if (campaign.status !== 'scheduled') throw new HttpError(409, 'Only scheduled campaigns can be cancelled');
  run(db, "UPDATE campaigns SET status = 'draft', scheduled_at = NULL WHERE id = ?", id);
}

export function deleteCampaign(db, id) {
  const campaign = get(db, 'SELECT status FROM campaigns WHERE id = ?', id);
  if (!campaign) throw new HttpError(404, 'Campaign not found');
  if (!['draft', 'scheduled'].includes(campaign.status)) throw new HttpError(409, 'Only drafts and scheduled campaigns can be deleted');
  run(db, 'DELETE FROM campaigns WHERE id = ?', id);
}

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;

// Email: body is escaped before merge fields are filled, so typed text cannot inject markup.
export function renderMessage(row, { publicBaseUrl }) {
  const unsubscribeUrl = `${publicBaseUrl}/unsubscribe/${row.unsub_token}`;
  const fields = {
    first_name: row.first_name || '',
    last_name: row.last_name || '',
    name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    email: row.email || '',
    valley: row.valley_name || '',
    unsubscribe_url: unsubscribeUrl,
  };
  const fill = (template) => template.replace(PLACEHOLDER, (_, key) => fields[key] ?? '');
  // Plain-text templates are escaped first. Editor HTML was sanitised when saved, so only the merged values need escaping.
  const fillHtml = (template, isHtml = false) =>
    (isHtml ? template : escapeHtml(template)).replace(PLACEHOLDER, (_, key) => escapeHtml(fields[key] ?? ''));

  if (row.channel === 'sms') {
    let text = fill(row.body).trim();
    if (!/reply stop/i.test(text)) text += '\n\nReply STOP to opt out.';
    return { text };
  }

  const subject = fill(row.subject).replace(/[\r\n]+/g, ' ').trim();
  const body = fill(row.body);
  const text = `${body}\n\n---\nTo stop receiving these emails: ${unsubscribeUrl}`;
  const html = [
    '<div style="font-family:Georgia,serif;font-size:16px;line-height:1.5;color:#1a1a1a">',
    row.body_html ? fillHtml(row.body_html, true) : fillHtml(row.body).replace(/\r?\n/g, '<br>'),
    '<hr style="border:none;border-top:1px solid #ccc;margin:24px 0">',
    `<p style="font-size:12px;color:#555">You are receiving this because you are connected with ${escapeHtml(row.valley_name || '')}. `,
    `<a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a></p></div>`,
  ].join('');
  return {
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

const QUEUE_SQL = `
  SELECT m.id AS message_id, m.to_address, cp.channel, cp.subject, cp.body, cp.body_html,
         c.first_name, c.last_name, c.email, c.phone, c.unsub_token,
         c.email_opt_in, c.email_suppressed, c.sms_opt_in, c.sms_suppressed,
         v.name AS valley_name
    FROM messages m
    JOIN campaigns cp ON cp.id = m.campaign_id
    JOIN contacts c ON c.id = m.contact_id
    JOIN valleys v ON v.id = cp.valley_id
   WHERE m.status = 'pending' AND cp.status = 'sending' AND cp.channel = ?
   ORDER BY m.id
   LIMIT ?`;

let busy = false;

// Moves due scheduled campaigns into sending, sends a batch per channel, then closes finished campaigns.
export async function processQueue(db, { sms, email, publicBaseUrl, smsPerTick = 20, emailPerTick = 50, log = () => {} }) {
  const totals = { sent: 0, failed: 0, skipped: 0 };
  if (busy) return { ...totals, busy: true };
  busy = true;
  try {
    for (const due of all(db, "SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?", nowIso())) {
      try {
        startCampaign(db, due.id);
      } catch (err) {
        log(`could not start scheduled campaign ${due.id}: ${err.message}`);
      }
    }

    for (const channel of ['sms', 'email']) {
      const limit = channel === 'sms' ? smsPerTick : emailPerTick;
      for (const row of all(db, QUEUE_SQL, channel, limit)) {
        // Re-check consent at send time. A STOP can arrive after the audience was snapshotted.
        if (!isEligible(row, channel)) {
          run(db, "UPDATE messages SET status = 'skipped', reason = 'opted out before send' WHERE id = ?", row.message_id);
          totals.skipped += 1;
          continue;
        }
        try {
          const msg = renderMessage(row, { publicBaseUrl });
          const result = channel === 'sms'
            ? await sms.send({ to: row.to_address, body: msg.text })
            : await email.send({ to: row.to_address, subject: msg.subject, text: msg.text, html: msg.html, headers: msg.headers });
          run(
            db,
            "UPDATE messages SET status = 'sent', provider_id = ?, sent_at = ? WHERE id = ?",
            result?.id ?? null, nowIso(), row.message_id,
          );
          totals.sent += 1;
        } catch (err) {
          run(db, "UPDATE messages SET status = 'failed', reason = ? WHERE id = ?", str(err.message).slice(0, 300), row.message_id);
          totals.failed += 1;
          log(`send failed for message ${row.message_id}: ${err.message}`);
        }
      }
    }

    run(
      db,
      `UPDATE campaigns SET status = 'sent', sent_at = ?
        WHERE status = 'sending'
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.status = 'pending')`,
      nowIso(),
    );
    return totals;
  } finally {
    busy = false;
  }
}
