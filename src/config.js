'use strict';

const path = require('node:path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function trustProxy(value) {
  if (value === undefined || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (['true', 'false'].includes(value)) return value === 'true';
  return value; // liste d'IP / sous-réseaux, ex. "loopback, 172.16.0.0/12"
}

const DEFAULT_EXTENSIONS =
  'pdf,png,jpg,jpeg,webp,gif,txt,md,tex,py,ipynb,csv,doc,docx,xls,xlsx,ppt,pptx,odt,ods,odp,zip';

function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

  return {
    production,
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    dataDir,
    filesDir: path.join(dataDir, 'files'),
    tmpDir: path.join(dataDir, 'tmp'),
    dbPath: path.join(dataDir, 'app.db'),
    // true : tout le monde peut consulter ; false : connexion obligatoire.
    publicRead: bool(env.PUBLIC_READ, true),
    trustProxy: trustProxy(env.TRUST_PROXY),
    // Origine publique attendue (ex. https://cours.exemple.fr) pour la vérification CSRF.
    appOrigin: env.APP_ORIGIN ? env.APP_ORIGIN.replace(/\/+$/, '') : null,
    cookieSecure: bool(env.COOKIE_SECURE, production),
    sessionTtlMs: int(env.SESSION_TTL_HOURS, 24) * 3600 * 1000,
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 100) * 1024 * 1024,
    maxFilesPerUpload: int(env.MAX_FILES_PER_UPLOAD, 50),
    allowedExtensions: new Set(
      (env.ALLOWED_EXTENSIONS || DEFAULT_EXTENSIONS)
        .split(',')
        .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
        .filter(Boolean),
    ),
    adminUsername: env.ADMIN_USERNAME || 'admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    siteTitle: env.SITE_TITLE || 'Prépa TSI · Cours',
    loginRateLimit: int(env.LOGIN_RATE_LIMIT, 10),
  };
}

module.exports = { loadConfig };
