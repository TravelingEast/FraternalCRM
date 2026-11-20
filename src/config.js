import path from 'node:path';

// Reads configuration from environment variables. Pass a custom object in tests.
export function loadConfig(env = process.env) {
  const dataDir = env.DATA_DIR || path.resolve('data');
  return {
    port: Number(env.PORT || 3000),
    dbFile: env.DB_FILE || path.join(dataDir, 'fraternal-crm.sqlite'),
    publicBaseUrl: (env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    trustProxy: env.TRUST_PROXY === '1',
    orientName: env.ORIENT_NAME || 'Orient',
    tickMs: Number(env.TICK_MS || 15000),
    smsPerTick: Number(env.SMS_PER_TICK || 20),
    emailPerTick: Number(env.EMAIL_PER_TICK || 50),
    smsProvider: env.SMS_PROVIDER || 'console',
    emailProvider: env.EMAIL_PROVIDER || 'console',
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      from: env.TWILIO_FROM,
    },
    telnyx: { apiKey: env.TELNYX_API_KEY, from: env.TELNYX_FROM },
    emailFrom: env.EMAIL_FROM || 'Lodge Mailer <noreply@example.org>',
    smtpUrl: env.SMTP_URL,
    bootstrap: {
      email: env.SUPER_ADMIN_EMAIL,
      password: env.SUPER_ADMIN_PASSWORD,
      name: env.SUPER_ADMIN_NAME || 'Statewide Administrator',
    },
  };
}
