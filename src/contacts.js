import { randomBytes } from 'node:crypto';
import { all, get, run, tx } from './db.js';
import { HttpError } from './errors.js';
import { parseCsv, toCsv } from './csv.js';
import { nowIso, str } from './util.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_IMPORT_ROWS = 20000;

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL_RE.test(email) ? email : null;
}

// Returns E.164 or null. Numbers without a leading + are read as US/Canada (+1).
export function normalizePhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = String(value).trim();
  const digits = raw.replace(/\D/g, '');
  let e164 = null;
  if (raw.startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  return e164 && /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

export const newUnsubToken = () => randomBytes(24).toString('base64url');

export function logConsent(db, contactId, channel, action, source) {
  run(
    db,
    'INSERT INTO consent_log (contact_id, channel, action, source, created_at) VALUES (?, ?, ?, ?, ?)',
    contactId, channel, action, source, nowIso(),
  );
}

// Opt-in is granted unless the person has opted out. Suppression is only lifted by the person (STOP/START or their own action), never by an import or API call.
function grantConsent(db, contact, channel, source) {
  if (contact[`${channel}_suppressed`] === 1) return 'suppressed';
  if (contact[`${channel}_opt_in`] === 1) return 'already';
  run(db, `UPDATE contacts SET ${channel}_opt_in = 1, updated_at = ? WHERE id = ?`, nowIso(), contact.id);
  logConsent(db, contact.id, channel, 'opt_in', source);
  return 'granted';
}

// Creates or matches a contact by email or phone within one valley. Existing blank fields are filled; filled fields are never overwritten.
export function upsertContact(db, valleyId, input = {}, { source = 'api' } = {}) {
  const warnings = [];
  let email = normalizeEmail(input.email);
  let phone = normalizePhone(input.phone);
  if (str(input.email) && !email) warnings.push(`ignored invalid email "${str(input.email).slice(0, 80)}"`);
  if (str(input.phone) && !phone) warnings.push(`ignored invalid phone "${str(input.phone).slice(0, 40)}"`);
  if (!email && !phone) return { action: 'skipped', reason: 'needs a valid email or phone', warnings };

  const byEmail = email ? get(db, 'SELECT * FROM contacts WHERE valley_id = ? AND email = ?', valleyId, email) : undefined;
  const byPhone = phone ? get(db, 'SELECT * FROM contacts WHERE valley_id = ? AND phone = ?', valleyId, phone) : undefined;
  const existing = byEmail || byPhone;
  if (byEmail && byPhone && byEmail.id !== byPhone.id) {
    phone = null;
    warnings.push('phone belongs to a different contact in this valley; phone not added');
  }

  const firstName = str(input.first_name).slice(0, 120);
  const lastName = str(input.last_name).slice(0, 120);
  const notes = str(input.notes).slice(0, 5000);
  const wantsEmail = input.email_opt_in === true;
  const wantsSms = input.sms_opt_in === true;

  if (!existing) {
    const ts = nowIso();
    const info = run(
      db,
      `INSERT INTO contacts (valley_id, first_name, last_name, email, phone, unsub_token, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      valleyId, firstName, lastName, email, phone, newUnsubToken(), notes, ts, ts,
    );
    const id = Number(info.lastInsertRowid);
    const contact = get(db, 'SELECT * FROM contacts WHERE id = ?', id);
    const consent = {};
    if (wantsEmail && email) consent.email = grantConsent(db, contact, 'email', source);
    if (wantsSms && phone) consent.sms = grantConsent(db, contact, 'sms', source);
    return { action: 'created', id, consent, warnings };
  }

  const updates = {};
  if (!existing.first_name && firstName) updates.first_name = firstName;
  if (!existing.last_name && lastName) updates.last_name = lastName;
  if (!existing.notes && notes) updates.notes = notes;
  if (!existing.email && email && !byEmail) updates.email = email;
  if (!existing.phone && phone && !byPhone) updates.phone = phone;
  const keys = Object.keys(updates);
  if (keys.length) {
    run(
      db,
      `UPDATE contacts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      ...keys.map((k) => updates[k]), nowIso(), existing.id,
    );
  }
  const current = get(db, 'SELECT * FROM contacts WHERE id = ?', existing.id);
  const consent = {};
  if (wantsEmail && current.email) consent.email = grantConsent(db, current, 'email', source);
  if (wantsSms && current.phone) consent.sms = grantConsent(db, current, 'sms', source);
  return { action: 'matched', id: existing.id, consent, warnings };
}

export function addToList(db, listId, contactIds) {
  let added = 0;
  // The join enforces that each contact belongs to the same valley as the list.
  for (const contactId of contactIds) {
    const info = run(
      db,
      `INSERT OR IGNORE INTO list_members (list_id, contact_id, added_at)
       SELECT l.id, c.id, ? FROM lists l JOIN contacts c ON c.valley_id = l.valley_id
       WHERE l.id = ? AND c.id = ?`,
      nowIso(), listId, contactId,
    );
    added += info.changes;
  }
  return added;
}

export function assertList(db, listId, valleyId) {
  if (!get(db, 'SELECT id FROM lists WHERE id = ? AND valley_id = ?', listId, valleyId)) {
    throw new HttpError(400, 'That list does not exist in this valley');
  }
}

export function contactWhere({ valleyId, listId = null, q = null }) {
  const clauses = ['c.valley_id = ?'];
  const params = [valleyId];
  if (listId) {
    clauses.push('c.id IN (SELECT contact_id FROM list_members WHERE list_id = ?)');
    params.push(listId);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    clauses.push("(c.first_name LIKE ? ESCAPE '\\' OR c.last_name LIKE ? ESCAPE '\\' OR c.email LIKE ? ESCAPE '\\' OR c.phone LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  return { where: clauses.join(' AND '), params };
}

const FIELD_ALIASES = {
  first_name: ['firstname', 'first', 'fname', 'givenname', 'forename'],
  last_name: ['lastname', 'last', 'lname', 'surname', 'familyname'],
  name: ['name', 'fullname'],
  email: ['email', 'emailaddress'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobilephone', 'mobilenumber', 'cell', 'cellphone', 'cellnumber', 'sms'],
  notes: ['notes', 'note', 'comments', 'comment'],
};

export function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((header, index) => {
    const key = String(header).toLowerCase().replace(/[^a-z]/g, '');
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (map[field] === undefined && aliases.includes(key)) {
        map[field] = index;
        break;
      }
    }
  });
  return map;
}

function splitName(full) {
  const parts = str(full).split(/\s+/).filter(Boolean);
  return parts.length ? [parts[0], parts.slice(1).join(' ')] : ['', ''];
}

export function importContacts(db, valleyId, csvText, { listId = null, consentEmail = false, consentSms = false, source = 'import' } = {}) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new HttpError(400, 'The file needs a header row and at least one contact.');
  if (rows.length - 1 > MAX_IMPORT_ROWS) throw new HttpError(413, `Imports are limited to ${MAX_IMPORT_ROWS} rows per file.`);
  const map = mapHeaders(rows[0]);
  if (map.email === undefined && map.phone === undefined) {
    throw new HttpError(400, 'The file needs an "email" or "phone" column.');
  }

  const summary = { total: rows.length - 1, created: 0, matched: 0, skipped: 0, opted_out_not_resubscribed: 0, warnings: [] };
  const note = (line, message) => {
    if (summary.warnings.length < 100) summary.warnings.push({ line, message });
  };

  tx(db, () => {
    rows.slice(1).forEach((row, i) => {
      const line = i + 2;
      const col = (field) => (map[field] === undefined ? '' : row[map[field]] ?? '');
      let firstName = col('first_name');
      let lastName = col('last_name');
      if (!firstName && !lastName && map.name !== undefined) [firstName, lastName] = splitName(col('name'));

      const result = upsertContact(
        db,
        valleyId,
        {
          first_name: firstName,
          last_name: lastName,
          email: col('email'),
          phone: col('phone'),
          notes: col('notes'),
          email_opt_in: consentEmail,
          sms_opt_in: consentSms,
        },
        { source },
      );
      result.warnings.forEach((w) => note(line, w));
      if (result.action === 'skipped') {
        summary.skipped += 1;
        note(line, result.reason);
        return;
      }
      if (result.action === 'created') summary.created += 1;
      else summary.matched += 1;
      if (listId) addToList(db, listId, [result.id]);
      for (const outcome of Object.values(result.consent)) {
        if (outcome === 'suppressed') summary.opted_out_not_resubscribed += 1;
      }
    });
  });
  return summary;
}

const EXPORT_COLS = [
  'first_name', 'last_name', 'email', 'phone', 'email_opt_in', 'email_suppressed',
  'sms_opt_in', 'sms_suppressed', 'notes', 'created_at',
];

export function contactsToCsv(db, valleyId, listId = null) {
  const { where, params } = contactWhere({ valleyId, listId });
  const rows = all(
    db,
    `SELECT ${EXPORT_COLS.map((c) => `c.${c}`).join(', ')} FROM contacts c WHERE ${where} ORDER BY c.last_name, c.first_name, c.id`,
    ...params,
  );
  return toCsv([EXPORT_COLS, ...rows.map((r) => EXPORT_COLS.map((c) => r[c]))]);
}
