import { get, run } from './db.js';
import { hashPassword } from './auth.js';
import { normalizeEmail } from './contacts.js';
import { nowIso } from './util.js';

// Sets the password for an existing user, or creates a statewide admin when the email is new.
// Signs that user out everywhere. Returns 'reset' or 'created'.
export function setAdminPassword(db, email, password, name = 'Statewide Administrator') {
  const clean = normalizeEmail(email);
  if (!clean) throw new Error('Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 10) throw new Error('Passwords must be at least 10 characters.');
  const user = get(db, 'SELECT id FROM users WHERE email = ?', clean);
  if (user) {
    run(db, 'UPDATE users SET password_hash = ?, active = 1 WHERE id = ?', hashPassword(password), user.id);
    run(db, 'DELETE FROM sessions WHERE user_id = ?', user.id);
    return 'reset';
  }
  run(
    db,
    'INSERT INTO users (email, name, password_hash, role, valley_id, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)',
    clean, name, hashPassword(password), 'super_admin', nowIso(),
  );
  return 'created';
}
