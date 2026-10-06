#!/usr/bin/env node
'use strict';

/*
 * Gestion des comptes en ligne de commande.
 *
 *   node scripts/users.js list
 *   node scripts/users.js add <identifiant> [admin|viewer]
 *   node scripts/users.js passwd <identifiant>
 *   node scripts/users.js role <identifiant> <admin|viewer>
 *   node scripts/users.js delete <identifiant>
 *
 * Le mot de passe est demandé de façon masquée (ou lu dans la variable NEW_PASSWORD).
 * Avec Docker :  docker compose exec app node scripts/users.js add prof admin
 */

const readline = require('node:readline');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { hashPassword, validatePassword } = require('../src/security');

function askHidden(question) {
  if (process.env.NEW_PASSWORD) return Promise.resolve(process.env.NEW_PASSWORD);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => {}; // aucun écho de la saisie
    rl.question('', (answer) => {
      rl.output.write('\n');
      rl.close();
      resolve(answer);
    });
  });
}

async function askNewPassword() {
  const first = await askHidden('Nouveau mot de passe : ');
  const problem = validatePassword(first);
  if (problem) throw new Error(problem);
  if (!process.env.NEW_PASSWORD) {
    const second = await askHidden('Confirmation : ');
    if (first !== second) throw new Error('Les mots de passe ne correspondent pas.');
  }
  return first;
}

function checkRole(role) {
  if (!['admin', 'viewer'].includes(role)) throw new Error('Rôle invalide (admin ou viewer).');
  return role;
}

async function main() {
  const [cmd, username, arg] = process.argv.slice(2);
  const db = openDatabase(loadConfig());
  const find = (name) => db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(name);
  const need = (name) => {
    if (!name) throw new Error('Identifiant manquant.');
    const user = find(name);
    if (!user) throw new Error(`Utilisateur « ${name} » introuvable.`);
    return user;
  };

  switch (cmd) {
    case 'list': {
      const rows = db.prepare('SELECT username, role, created_at FROM users ORDER BY username').all();
      for (const r of rows) console.log(`${r.username.padEnd(24)} ${r.role.padEnd(8)} ${new Date(r.created_at).toISOString()}`);
      if (!rows.length) console.log('(aucun utilisateur)');
      break;
    }
    case 'add': {
      if (!username || !/^[\w.@-]{2,64}$/.test(username)) {
        throw new Error('Identifiant invalide (2 à 64 caractères : lettres, chiffres, . _ @ -).');
      }
      if (find(username)) throw new Error('Cet utilisateur existe déjà.');
      const role = checkRole(arg || 'viewer');
      const hash = await hashPassword(await askNewPassword());
      db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
        username,
        hash,
        role,
        Date.now(),
      );
      console.log(`Utilisateur « ${username} » (${role}) créé.`);
      break;
    }
    case 'passwd': {
      const user = need(username);
      const hash = await hashPassword(await askNewPassword());
      db.transaction(() => {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      })();
      console.log('Mot de passe modifié ; sessions existantes révoquées.');
      break;
    }
    case 'role': {
      const user = need(username);
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(checkRole(arg), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      console.log(`Rôle de « ${user.username} » : ${arg}.`);
      break;
    }
    case 'delete': {
      const user = need(username);
      db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      console.log(`Utilisateur « ${user.username} » supprimé.`);
      break;
    }
    default:
      console.log('Usage : node scripts/users.js <list|add|passwd|role|delete> [identifiant] [rôle]');
      process.exitCode = cmd ? 1 : 0;
  }
  db.close();
}

main().catch((err) => {
  console.error(`Erreur : ${err.message}`);
  process.exit(1);
});
