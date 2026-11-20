import crypto from 'node:crypto';
import { get, run } from './db.js';
import { HttpError } from './errors.js';
import { nowIso, optionalInt } from './util.js';

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'frc_session';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function generateApiKey() {
  const key = `frc_${crypto.randomBytes(24).toString('base64url')}`;
  return { key, hash: sha256(key) };
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  run(
    db,
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    sha256(token), userId, new Date(Date.now() + SESSION_MS).toISOString(),
  );
  return token;
}

export function destroySession(db, token) {
  if (token) run(db, 'DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function setSessionCookie(res, token, config) {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`);
}

export function clearSessionCookie(res, config) {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

export function sessionMiddleware(db) {
  return (req, res, next) => {
    const token = readCookie(req, COOKIE);
    req.user = null;
    if (token) {
      req.user = get(
        db,
        `SELECT u.id, u.email, u.name, u.role, u.valley_id
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
        sha256(token), nowIso(),
      ) || null;
    }
    req.sessionToken = token;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Sign in to continue'));
  next();
}

export function requireSuper(req, res, next) {
  if (req.user?.role !== 'super_admin') return next(new HttpError(403, 'Statewide administrators only'));
  next();
}

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, valley_id: u.valley_id ?? null };
}

export function canAccessValley(user, valleyId) {
  return user.role === 'super_admin' || user.valley_id === Number(valleyId);
}

// Valley admins are always pinned to their own valley. Statewide admins must name one.
export function resolveValley(db, req) {
  const raw = req.query?.valley_id ?? req.body?.valley_id;
  if (req.user.role === 'valley_admin') {
    if (raw !== undefined && raw !== null && raw !== '' && Number(raw) !== req.user.valley_id) {
      throw new HttpError(403, 'You can only manage your own valley');
    }
    return req.user.valley_id;
  }
  const id = optionalInt(raw);
  if (!id || !get(db, 'SELECT id FROM valleys WHERE id = ?', id)) throw new HttpError(400, 'Choose a valley first');
  return id;
}

// Returns the row only if the signed-in user may see it. Otherwise 404, so IDs do not leak.
export function loadForUser(db, req, table, id) {
  const row = get(db, `SELECT * FROM ${table} WHERE id = ?`, id);
  if (!row || !canAccessValley(req.user, row.valley_id)) throw new HttpError(404, 'Not found');
  return row;
}

export class RateLimiter {
  constructor({ max, windowMs }) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  isLimited(key) {
    const entry = this.hits.get(key);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.hits.delete(key);
      return false;
    }
    return entry.count >= this.max;
  }

  fail(key) {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || now > entry.resetAt) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count += 1;
  }

  clear(key) {
    this.hits.delete(key);
  }
}

export function apiKeyAuth(db) {
  return (req, res, next) => {
    const match = /^Bearer\s+(frc_[A-Za-z0-9_-]+)$/.exec(req.get('Authorization') || '');
    const row = match
      ? get(db, 'SELECT id, valley_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', sha256(match[1]))
      : null;
    if (!row) return next(new HttpError(401, 'Missing or invalid API key'));
    run(db, 'UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
    req.apiKey = row;
    req.apiValleyId = row.valley_id;
    next();
  };
}

// Creates the first statewide admin from environment variables when the database has no users.
export function bootstrapSuperAdmin(db, boot) {
  const { n } = get(db, 'SELECT COUNT(*) AS n FROM users');
  if (n > 0 || !boot.email || !boot.password) return false;
  if (boot.password.length < 10) throw new Error('SUPER_ADMIN_PASSWORD must be at least 10 characters');
  run(
    db,
    'INSERT INTO users (email, name, password_hash, role, valley_id, active, created_at) VALUES (?, ?, ?, ?, NULL, 1, ?)',
    boot.email.trim().toLowerCase(), boot.name, hashPassword(boot.password), 'super_admin', nowIso(),
  );
  return true;
}
