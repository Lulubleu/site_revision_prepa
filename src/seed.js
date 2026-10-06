'use strict';

const crypto = require('node:crypto');
const { hashPassword } = require('./security');

const YEARS = ['TSI1', 'TSI2'];
const SUBJECTS = ['Anglais', 'Français', 'Maths', 'Physique-Chimie', 'SII'];
const SECTIONS = ['Colles', 'Cours', 'Exercices'];

/**
 * Crée l'arborescence par défaut au tout premier démarrage uniquement
 * (un drapeau en base évite de la recréer si l'admin la supprime ensuite).
 */
function seedFolders(db) {
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get();
  if (seeded) return false;

  const insert = db.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)');
  const now = Date.now();
  db.transaction(() => {
    for (const year of YEARS) {
      const yearId = insert.run(null, year, now).lastInsertRowid;
      for (const subject of SUBJECTS) {
        const subjectId = insert.run(yearId, subject, now).lastInsertRowid;
        for (const section of SECTIONS) insert.run(subjectId, section, now);
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('seeded', ?)").run(String(now));
  })();
  return true;
}

/**
 * S'il n'existe aucun utilisateur, crée le compte administrateur initial.
 * Sans ADMIN_PASSWORD, un mot de passe aléatoire est généré et affiché une seule fois.
 */
async function seedAdmin(db, config, log = console.log) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;

  let password = config.adminPassword;
  const generated = !password;
  if (generated) password = crypto.randomBytes(15).toString('base64url');

  db.prepare(
    "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'admin', ?)",
  ).run(config.adminUsername, await hashPassword(password), Date.now());

  if (generated) {
    log('='.repeat(64));
    log(` Compte administrateur créé : ${config.adminUsername}`);
    log(` Mot de passe généré       : ${password}`);
    log(' Changez-le dès la première connexion (menu Admin).');
    log('='.repeat(64));
  } else {
    log(`Compte administrateur "${config.adminUsername}" créé depuis ADMIN_PASSWORD.`);
  }
  return config.adminUsername;
}

module.exports = { seedFolders, seedAdmin, YEARS, SUBJECTS, SECTIONS };
