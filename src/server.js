'use strict';

const fs = require('node:fs');
const { loadConfig } = require('./config');
const { openDatabase } = require('./db');
const { seedFolders, seedAdmin } = require('./seed');
const { createApp } = require('./app');

async function main() {
  const config = loadConfig();
  const db = openDatabase(config);

  if (seedFolders(db)) console.log('Arborescence par défaut créée (TSI1, TSI2).');
  await seedAdmin(db, config);

  if (config.production && !config.cookieSecure) {
    console.warn('ATTENTION : COOKIE_SECURE=false en production — à n’utiliser que derrière un réseau de confiance.');
  }

  const { app, sessions } = createApp({ db, config });

  // Ménage périodique : sessions expirées et fichiers temporaires d'upload orphelins.
  const cleanup = () => {
    sessions.purgeExpired();
    const cutoff = Date.now() - 6 * 3600 * 1000;
    for (const name of fs.readdirSync(config.tmpDir)) {
      const p = `${config.tmpDir}/${name}`;
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch {
        /* déjà supprimé */
      }
    }
  };
  cleanup();
  setInterval(cleanup, 3600 * 1000).unref();

  const server = app.listen(config.port, config.host, () => {
    console.log(`Serveur démarré sur http://${config.host}:${config.port}`);
    console.log(`Consultation ${config.publicRead ? 'publique' : 'réservée aux utilisateurs connectés'}.`);
  });
  server.requestTimeout = 30 * 60 * 1000; // gros uploads sur connexions lentes

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
