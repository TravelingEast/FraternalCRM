import crypto from 'node:crypto';

// Every provider exposes send({ to, body }) and resolves to { id }. It throws on failure.
export function createSmsProvider(config, { fetchImpl = globalThis.fetch, log = console.log } = {}) {
  switch (config.smsProvider) {
    case 'console':
      return {
        name: 'console',
        async send({ to, body }) {
          log(`[sms:console] to=${to} body=${JSON.stringify(body)}`);
          return { id: `console-${crypto.randomUUID()}` };
        },
      };
    case 'twilio':
      return twilioProvider(config.twilio, fetchImpl);
    case 'telnyx':
      return telnyxProvider(config.telnyx, fetchImpl);
    default:
      throw new Error(`Unknown SMS_PROVIDER "${config.smsProvider}". Use console, twilio or telnyx.`);
  }
}

function requireFields(name, obj, keys) {
  const missing = keys.filter((k) => !obj[k]);
  if (missing.length) throw new Error(`${name} is missing: ${missing.join(', ')}`);
}

function twilioProvider(cfg, fetchImpl) {
  requireFields('Twilio', cfg, ['accountSid', 'authToken', 'from']);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`;
  // A Messaging Service SID (MG...) lets Twilio pick the sender and handle opt-out keywords.
  const sender = cfg.from.startsWith('MG') ? { MessagingServiceSid: cfg.from } : { From: cfg.from };
  const auth = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`;
  return {
    name: 'twilio',
    async send({ to, body }) {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, Body: body, ...sender }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Twilio ${res.status}: ${data.message || 'send failed'}${data.code ? ` (code ${data.code})` : ''}`);
      }
      return { id: data.sid };
    },
  };
}

function telnyxProvider(cfg, fetchImpl) {
  requireFields('Telnyx', cfg, ['apiKey', 'from']);
  return {
    name: 'telnyx',
    async send({ to, body }) {
      const res = await fetchImpl('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: cfg.from, to, text: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Telnyx ${res.status}: ${data.errors?.[0]?.detail || 'send failed'}`);
      return { id: data.data?.id };
    },
  };
}

// Twilio request signing: HMAC-SHA1 over the full URL plus sorted POST params.
export function validateTwilioSignature(authToken, url, params, signature) {
  if (!authToken || !signature) return false;
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const expected = crypto.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
