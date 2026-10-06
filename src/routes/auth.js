'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const {
  verifyPassword,
  verifyAgainstDummy,
  hashPassword,
  validatePassword,
  requireAuth,
  HttpError,
} = require('../security');

function authRoutes({ db, config, sessions }) {
  const router = express.Router();

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: config.loginRateLimit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.' },
  });

  const findUser = db.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?');

  function publicUser(user) {
    return user ? { username: user.username, role: user.role } : null;
  }

  router.get('/me', (req, res) => {
    res.json({
      user: publicUser(req.user),
      csrfToken: req.session ? req.session.csrfToken : null,
      publicRead: config.publicRead,
      siteTitle: config.siteTitle,
    });
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) {
      throw new HttpError(400, 'Identifiants invalides.');
    }
    const user = findUser.get(username.trim());
    const ok = user ? await verifyPassword(user.password_hash, password) : await verifyAgainstDummy(password);
    if (!ok) throw new HttpError(401, 'Identifiant ou mot de passe incorrect.');

    // Nouvelle session à chaque connexion (pas de fixation de session).
    if (req.session) sessions.destroy(req, res);
    const csrfToken = sessions.create(res, user.id);
    res.json({ user: publicUser(user), csrfToken });
  });

  router.post('/logout', (req, res) => {
    sessions.destroy(req, res);
    res.json({ ok: true });
  });

  router.post('/password', requireAuth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (typeof currentPassword !== 'string' || !(await verifyPassword(user.password_hash, currentPassword))) {
      throw new HttpError(400, 'Mot de passe actuel incorrect.');
    }
    const problem = validatePassword(newPassword);
    if (problem) throw new HttpError(400, problem);

    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), req.user.id);
    sessions.revokeOthers(req.session);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { authRoutes };
