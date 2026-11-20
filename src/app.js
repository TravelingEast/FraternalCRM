import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionMiddleware } from './auth.js';
import { HttpError } from './errors.js';
import { adminRouter } from './routes/admin.js';
import { v1Router } from './routes/v1.js';
import { publicRouter } from './routes/public.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createApp({ db, config }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware(db));

  app.use('/api/v1', v1Router({ db, config }));
  app.use('/api', adminRouter({ db, config }));
  app.use(publicRouter({ db, config }));
  app.use(express.static(publicDir, { index: 'index.html' }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
    if (/UNIQUE constraint failed/.test(err.message || '')) {
      return res.status(409).json({ error: 'That value is already in use.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  return app;
}
