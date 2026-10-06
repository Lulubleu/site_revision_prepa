'use strict';

const crypto = require('node:crypto');
const argon2 = require('argon2');

// Paramètres Argon2id (recommandations OWASP : m=19 MiB, t=2, p=1 au minimum).
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

// Hash factice : on vérifie quand même un mot de passe quand l'utilisateur
// n'existe pas, pour ne pas révéler son existence par le temps de réponse.
let dummyHash;

async function hashPassword(password) {
  return argon2.hash(password, ARGON_OPTS);
}

async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

async function verifyAgainstDummy(password) {
  dummyHash ||= await hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(dummyHash, password);
  return false;
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Le mot de passe doit contenir au moins 10 caractères.';
  }
  if (password.length > 256) return 'Mot de passe trop long.';
  return null;
}

function createSessionStore(db, config) {
  const cookieName = config.cookieSecure ? '__Host-sid' : 'sid';

  const stmt = {
    insert: db.prepare(
      'INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ),
    get: db.prepare(`
      SELECT s.token_hash, s.csrf_token, s.expires_at, u.id, u.username, u.role
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`),
    delete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteForUser: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?'),
    purge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };

  function cookieOptions() {
    return {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'strict',
      path: '/',
      maxAge: config.sessionTtlMs,
    };
  }

  function readToken(req) {
    const header = req.headers.cookie;
    if (!header) return null;
    for (const part of header.split(';')) {
      const idx = part.indexOf('=');
      if (idx === -1) continue;
      if (part.slice(0, idx).trim() === cookieName) {
        const value = part.slice(idx + 1).trim();
        return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
      }
    }
    return null;
  }

  return {
    cookieName,

    create(res, userId) {
      const token = crypto.randomBytes(32).toString('base64url');
      const csrf = crypto.randomBytes(32).toString('base64url');
      const now = Date.now();
      stmt.insert.run(sha256(token), userId, csrf, now, now + config.sessionTtlMs);
      res.cookie(cookieName, token, cookieOptions());
      return csrf;
    },

    load(req) {
      const token = readToken(req);
      if (!token) return null;
      const row = stmt.get.get(sha256(token));
      if (!row) return null;
      if (row.expires_at < Date.now()) {
        stmt.delete.run(row.token_hash);
        return null;
      }
      return {
        tokenHash: row.token_hash,
        csrfToken: row.csrf_token,
        user: { id: row.id, username: row.username, role: row.role },
      };
    },

    destroy(req, res) {
      if (req.session) stmt.delete.run(req.session.tokenHash);
      res.clearCookie(cookieName, { ...cookieOptions(), maxAge: undefined });
    },

    revokeOthers(session) {
      stmt.deleteForUser.run(session.user.id, session.tokenHash);
    },

    purgeExpired() {
      return stmt.purge.run(Date.now()).changes;
    },
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Charge la session (si présente) dans req.session / req.user. */
function sessionMiddleware(sessions) {
  return (req, _res, next) => {
    req.session = sessions.load(req);
    req.user = req.session ? req.session.user : null;
    next();
  };
}

/** Lecture : publique ou réservée aux utilisateurs connectés selon PUBLIC_READ. */
function requireRead(config) {
  return (req, _res, next) => {
    if (config.publicRead || req.user) return next();
    next(new HttpError(401, 'Connexion requise.'));
  };
}

function requireAuth(req, _res, next) {
  if (req.user) return next();
  next(new HttpError(401, 'Connexion requise.'));
}

function requireAdmin(req, _res, next) {
  if (!req.user) return next(new HttpError(401, 'Connexion requise.'));
  if (req.user.role !== 'admin') return next(new HttpError(403, 'Accès réservé aux administrateurs.'));
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Défense CSRF en profondeur pour toute requête modifiante :
 *  1. Sec-Fetch-Site ne doit pas être "cross-site" ;
 *  2. l'en-tête Origin (s'il est présent) doit correspondre à l'origine du site ;
 *  3. si une session existe, l'en-tête X-CSRF-Token doit correspondre au jeton de session.
 * (Le cookie est en plus SameSite=Strict.)
 */
function csrfProtection(config) {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const site = req.get('sec-fetch-site');
    if (site && !['same-origin', 'none'].includes(site)) {
      return next(new HttpError(403, 'Requête inter-sites refusée.'));
    }

    const origin = req.get('origin');
    if (origin) {
      const expected = config.appOrigin || `${req.protocol}://${req.get('host')}`;
      if (origin !== expected) return next(new HttpError(403, 'Origine non autorisée.'));
    }

    if (req.session) {
      const token = req.get('x-csrf-token');
      if (!token || !safeEqual(token, req.session.csrfToken)) {
        return next(new HttpError(403, 'Jeton CSRF invalide.'));
      }
    }
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  validatePassword,
  createSessionStore,
  sessionMiddleware,
  requireRead,
  requireAuth,
  requireAdmin,
  csrfProtection,
  HttpError,
};
