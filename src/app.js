'use strict';

const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const {
  createSessionStore,
  sessionMiddleware,
  requireRead,
  csrfProtection,
  HttpError,
} = require('./security');
const { createBlobStore } = require('./storage');
const { authRoutes } = require('./routes/auth');
const { folderRoutes, searchRoute } = require('./routes/folders');
const { fileRoutes } = require('./routes/files');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PDFJS_DIR = path.dirname(require.resolve('pdfjs-dist/package.json'));

function createApp({ db, config }) {
  const app = express();
  const sessions = createSessionStore(db, config);
  const blobs = createBlobStore(config);
  const ctx = { db, config, sessions, blobs };

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          workerSrc: ["'self'", 'blob:'],
          frameSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          ...(config.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      // HSTS : à activer seulement quand le site est servi en HTTPS.
      strictTransportSecurity: config.cookieSecure ? { maxAge: 31536000, includeSubDomains: false } : false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'same-origin' },
    }),
  );

  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: '16kb' }));
  api.use(sessionMiddleware(sessions));
  api.use(csrfProtection(config));
  api.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  api.use('/auth', authRoutes(ctx));

  const read = requireRead(config);
  const { fileRouter, folderUploadRouter } = fileRoutes(ctx);
  api.get('/search', read, searchRoute(ctx));
  api.use('/folders', read, folderUploadRouter, folderRoutes(ctx));
  api.use('/files', read, fileRouter);

  api.use((_req, _res, next) => next(new HttpError(404, 'Ressource introuvable.')));
  app.use('/api', api);

  // Fichiers statiques : PDF.js (local, aucune dépendance à un CDN) et l'interface.
  app.use(
    '/vendor/pdfjs',
    express.static(PDFJS_DIR, {
      index: false,
      maxAge: '7d',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.mjs')) res.type('text/javascript');
      },
    }),
  );
  app.use(express.static(PUBLIC_DIR, { index: false, maxAge: config.production ? '1h' : 0 }));

  // Routage côté client : /, /d/:id, /f/:uuid → index.html
  app.get(['/', /^\/(d|f)\/[^/]+\/?$/], (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  app.use((_req, res) => res.status(404).type('text/plain').send('Page introuvable.'));

  // Gestionnaire d'erreurs : messages contrôlés pour les HttpError, générique sinon.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    if (err.type === 'entity.parse.failed') status = 400;
    if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, err);
    const message = err instanceof HttpError || (status < 500 && err.expose) ? err.message : 'Erreur interne du serveur.';
    if (res.headersSent) return;
    res.status(status).json({ error: message });
  });

  return { app, sessions };
}

module.exports = { createApp };
