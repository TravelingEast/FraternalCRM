import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

// send({ to, subject, text, html, headers }) resolves to { id }. It throws on failure.
export function createEmailProvider(config, { log = console.log } = {}) {
  switch (config.emailProvider) {
    case 'console':
      return {
        name: 'console',
        async send({ to, subject }) {
          log(`[email:console] to=${to} subject=${JSON.stringify(subject)}`);
          return { id: `console-${crypto.randomUUID()}` };
        },
      };
    case 'smtp': {
      if (!config.smtpUrl) throw new Error('SMTP_URL is required when EMAIL_PROVIDER=smtp');
      const transport = nodemailer.createTransport(config.smtpUrl);
      return {
        name: 'smtp',
        async send(msg) {
          const info = await transport.sendMail({ from: config.emailFrom, ...msg });
          return { id: info.messageId };
        },
      };
    }
    default:
      throw new Error(`Unknown EMAIL_PROVIDER "${config.emailProvider}". Use console or smtp.`);
  }
}
