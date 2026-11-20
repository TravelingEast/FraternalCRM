import { openDb, run, get } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/auth.js';
import { nowIso } from '../src/util.js';

export function testDb() {
  return openDb(':memory:');
}

export function testConfig(overrides = {}) {
  return {
    ...loadConfig({ PUBLIC_BASE_URL: 'https://crm.example.org' }),
    smsProvider: 'console',
    emailProvider: 'console',
    twilio: { accountSid: 'AC123', authToken: 'test-token', from: '+15550001111' },
    ...overrides,
  };
}

// Fake providers that record what would have been sent.
export function fakeProviders() {
  const sms = [];
  const email = [];
  return {
    sms,
    email,
    smsProvider: {
      name: 'fake-sms',
      async send(msg) { sms.push(msg); return { id: `sms-${sms.length}` }; },
    },
    emailProvider: {
      name: 'fake-email',
      async send(msg) { email.push(msg); return { id: `em-${email.length}` }; },
    },
  };
}

export function seedValley(db, name = 'Sample Valley') {
  return Number(run(db, 'INSERT INTO valleys (name, city, created_at) VALUES (?, ?, ?)', name, 'Town', nowIso()).lastInsertRowid);
}

export function seedUser(db, { email, role = 'super_admin', valleyId = null, password = 'correct-horse-battery' }) {
  return Number(
    run(
      db,
      'INSERT INTO users (email, name, password_hash, role, valley_id, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      email, email.split('@')[0], hashPassword(password), role, valleyId, nowIso(),
    ).lastInsertRowid,
  );
}

export function startServer(overrides = {}) {
  const db = testDb();
  const config = testConfig(overrides.config);
  const providers = fakeProviders();
  const app = createApp({ db, config, sms: providers.smsProvider, email: providers.emailProvider });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const base = `http://127.0.0.1:${port}`;
      resolve({ db, config, providers, server, base, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Minimal cookie-aware client for the JSON API.
export function client(base) {
  let cookie = '';
  async function request(path, { method = 'GET', body, headers = {}, rawBody, contentType } = {}) {
    const init = { method, headers: { ...headers } };
    if (cookie) init.headers.Cookie = cookie;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (rawBody !== undefined) {
      init.headers['Content-Type'] = contentType;
      init.body = rawBody;
    }
    const res = await fetch(base + path, init);
    const set = res.headers.getSetCookie?.() || [];
    for (const c of set) {
      const [pair] = c.split(';');
      if (pair.startsWith('frc_session=')) cookie = pair;
    }
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, text, headers: res.headers };
  }
  return {
    request,
    login: (email, password) => request('/api/login', { method: 'POST', body: { email, password } }),
    logout() { cookie = ''; },
  };
}

export { get, run };
