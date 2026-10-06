'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const request = require('supertest');
const { loadConfig } = require('../src/config');
const { openDatabase } = require('../src/db');
const { seedFolders, seedAdmin } = require('../src/seed');
const { createApp } = require('../src/app');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const PASSWORD = 'motdepasse-de-test';

async function setup(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cours-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, ADMIN_PASSWORD: PASSWORD, LOGIN_RATE_LIMIT: '100', ...env });
  const db = openDatabase(config);
  seedFolders(db);
  await seedAdmin(db, config, () => {});
  const { app } = createApp({ db, config });
  return { app, db, config, dataDir };
}

async function loginAgent(app) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username: 'admin', password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken };
}

const folderId = (db, ...names) => {
  let id = null;
  for (const name of names) {
    id = db.prepare('SELECT id FROM folders WHERE parent_id IS ? AND name = ?').get(id, name).id;
  }
  return id;
};

describe('arborescence par défaut', () => {
  let ctx;
  before(async () => (ctx = await setup()));
  after(() => fs.rmSync(ctx.dataDir, { recursive: true, force: true }));

  test('TSI1/TSI2 × 5 matières × 3 sections', async () => {
    const root = await request(ctx.app).get('/api/folders/root').expect(200);
    assert.deepEqual(root.body.folders.map((f) => f.name).sort(), ['TSI1', 'TSI2']);
    for (const year of root.body.folders) {
      const res = await request(ctx.app).get(`/api/folders/${year.id}`).expect(200);
      assert.deepEqual(
        res.body.folders.map((f) => f.name).sort(),
        ['Anglais', 'Français', 'Maths', 'Physique-Chimie', 'SII'],
      );
      for (const subject of res.body.folders) {
        const sub = await request(ctx.app).get(`/api/folders/${subject.id}`).expect(200);
        assert.deepEqual(sub.body.folders.map((f) => f.name).sort(), ['Colles', 'Cours', 'Exercices']);
      }
    }
  });

  test('le seed ne recrée rien au redémarrage', () => {
    const before = ctx.db.prepare('SELECT COUNT(*) n FROM folders').get().n;
    assert.equal(seedFolders(ctx.db), false);
    assert.equal(ctx.db.prepare('SELECT COUNT(*) n FROM folders').get().n, before);
    assert.equal(before, 2 + 2 * 5 + 2 * 5 * 3);
  });
});

describe('authentification et autorisations', () => {
  let ctx;
  before(async () => (ctx = await setup()));
  after(() => fs.rmSync(ctx.dataDir, { recursive: true, force: true }));

  test('mauvais mot de passe refusé', async () => {
    await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: 'faux' }).expect(401);
    await request(ctx.app).post('/api/auth/login').send({ username: 'inconnu', password: 'faux' }).expect(401);
  });

  test('cookie de session HttpOnly + SameSite=Strict', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD }).expect(200);
    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
  });

  test('cookie __Host- et Secure quand COOKIE_SECURE=true', async () => {
    const secure = await setup({ COOKIE_SECURE: 'true' });
    const res = await request(secure.app).post('/api/auth/login').send({ username: 'admin', password: PASSWORD }).expect(200);
    assert.match(res.headers['set-cookie'][0], /^__Host-sid=.*Secure/);
    fs.rmSync(secure.dataDir, { recursive: true, force: true });
  });

  test('les actions admin exigent une connexion', async () => {
    const id = folderId(ctx.db, 'TSI1', 'Maths', 'Cours');
    await request(ctx.app).post('/api/folders').send({ parentId: id, name: 'X' }).expect(401);
    await request(ctx.app).delete(`/api/folders/${id}`).expect(401);
    await request(ctx.app).post(`/api/folders/${id}/files`).attach('files', PDF, 'a.pdf').expect(401);
  });

  test('un compte « viewer » ne peut rien modifier', async () => {
    const { hashPassword } = require('../src/security');
    ctx.db
      .prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES ('eleve', ?, 'viewer', 0)")
      .run(await hashPassword(PASSWORD));
    const agent = request.agent(ctx.app);
    const { body } = await agent.post('/api/auth/login').send({ username: 'eleve', password: PASSWORD }).expect(200);
    const id = folderId(ctx.db, 'TSI1', 'Maths', 'Cours');
    await agent.post('/api/folders').set('X-CSRF-Token', body.csrfToken).send({ parentId: id, name: 'X' }).expect(403);
  });

  test('CSRF : jeton absent ou faux → 403', async () => {
    const { agent, csrf } = await loginAgent(ctx.app);
    const id = folderId(ctx.db, 'TSI1', 'Maths');
    await agent.post('/api/folders').send({ parentId: id, name: 'A' }).expect(403);
    await agent.post('/api/folders').set('X-CSRF-Token', 'x'.repeat(43)).send({ parentId: id, name: 'A' }).expect(403);
    await agent.post('/api/folders').set('X-CSRF-Token', csrf).send({ parentId: id, name: 'A' }).expect(201);
  });

  test('CSRF : origine étrangère ou Sec-Fetch-Site cross-site → 403', async () => {
    const { agent, csrf } = await loginAgent(ctx.app);
    const id = folderId(ctx.db, 'TSI1', 'Maths');
    await agent.post('/api/folders').set('X-CSRF-Token', csrf).set('Origin', 'https://evil.example').send({ parentId: id, name: 'B' }).expect(403);
    await agent.post('/api/folders').set('X-CSRF-Token', csrf).set('Sec-Fetch-Site', 'cross-site').send({ parentId: id, name: 'B' }).expect(403);
    await request(ctx.app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ username: 'admin', password: PASSWORD }).expect(403);
  });

  test('déconnexion : la session est révoquée côté serveur', async () => {
    const { agent, csrf } = await loginAgent(ctx.app);
    await agent.post('/api/auth/logout').set('X-CSRF-Token', csrf).expect(200);
    const me = await agent.get('/api/auth/me').expect(200);
    assert.equal(me.body.user, null);
  });

  test('changement de mot de passe', async () => {
    const { agent, csrf } = await loginAgent(ctx.app);
    await agent.post('/api/auth/password').set('X-CSRF-Token', csrf).send({ currentPassword: 'faux', newPassword: 'nouveau-mot-de-passe' }).expect(400);
    await agent.post('/api/auth/password').set('X-CSRF-Token', csrf).send({ currentPassword: PASSWORD, newPassword: 'court' }).expect(400);
    await agent.post('/api/auth/password').set('X-CSRF-Token', csrf).send({ currentPassword: PASSWORD, newPassword: 'nouveau-mot-de-passe' }).expect(200);
    await agent.post('/api/auth/password').set('X-CSRF-Token', csrf).send({ currentPassword: 'nouveau-mot-de-passe', newPassword: PASSWORD }).expect(200);
  });
});

describe('mode privé (PUBLIC_READ=false)', () => {
  let ctx;
  before(async () => (ctx = await setup({ PUBLIC_READ: 'false' })));
  after(() => fs.rmSync(ctx.dataDir, { recursive: true, force: true }));

  test('lecture refusée sans connexion, autorisée après', async () => {
    await request(ctx.app).get('/api/folders/root').expect(401);
    await request(ctx.app).get('/api/search?q=maths').expect(401);
    const { agent } = await loginAgent(ctx.app);
    await agent.get('/api/folders/root').expect(200);
  });
});

describe('fichiers', () => {
  let ctx;
  let admin;
  let coursId;
  before(async () => {
    ctx = await setup();
    admin = await loginAgent(ctx.app);
    coursId = folderId(ctx.db, 'TSI1', 'Maths', 'Cours');
  });
  after(() => fs.rmSync(ctx.dataDir, { recursive: true, force: true }));

  const upload = (name, content = PDF) =>
    admin.agent.post(`/api/folders/${coursId}/files`).set('X-CSRF-Token', admin.csrf).attach('files', content, name);

  test('upload, affichage inline et téléchargement', async () => {
    const res = await upload('Cours – intégrales.pdf').expect(201);
    const { id, name } = res.body.files[0];
    assert.equal(name, 'Cours – intégrales.pdf');

    // Stocké sous un nom UUID opaque, jamais sous le nom d'origine.
    assert.ok(fs.existsSync(path.join(ctx.config.filesDir, id)));

    const view = await request(ctx.app).get(`/api/files/${id}/view`).expect(200);
    assert.equal(view.headers['content-type'], 'application/pdf');
    assert.match(view.headers['content-disposition'], /^inline;/);
    assert.equal(view.headers['x-content-type-options'], 'nosniff');

    const dl = await request(ctx.app).get(`/api/files/${id}/download`).expect(200);
    assert.match(dl.headers['content-disposition'], /^attachment;.*filename\*=UTF-8''Cours%20%E2%80%93%20int%C3%A9grales\.pdf/);

    // Requêtes partielles (utilisées par PDF.js).
    await request(ctx.app).get(`/api/files/${id}/view`).set('Range', 'bytes=0-4').expect(206);
  });

  test('doublon renommé automatiquement', async () => {
    await upload('doublon.pdf').expect(201);
    const res = await upload('doublon.pdf').expect(201);
    assert.equal(res.body.files[0].name, 'doublon (2).pdf');
  });

  test('extension interdite refusée', async () => {
    await upload('page.html', Buffer.from('<script>alert(1)</script>')).expect(415);
    await upload('image.svg', Buffer.from('<svg onload="alert(1)"/>')).expect(415);
  });

  test('contenu ne correspondant pas à l’extension refusé', async () => {
    const res = await upload('faux.pdf', Buffer.from('<html><script>alert(1)</script>')).expect(400);
    assert.equal(res.body.files.length, 0);
  });

  test('les fichiers non inline sont servis en pièce jointe sandboxée', async () => {
    const res = await upload('notes.txt', Buffer.from('bonjour')).expect(201);
    const view = await request(ctx.app).get(`/api/files/${res.body.files[0].id}/view`).expect(200);
    assert.equal(view.headers['content-type'], 'application/octet-stream');
    assert.match(view.headers['content-disposition'], /^attachment;/);
    assert.match(view.headers['content-security-policy'], /sandbox/);
  });

  test('path traversal impossible', async () => {
    for (const evil of ['..%2F..%2Fapp.db', '..%5C..%5Capp.db', '%2e%2e%2fapp.db', 'app.db', '../app.db']) {
      const res = await request(ctx.app).get(`/api/files/${evil}/download`);
      assert.ok([400, 404].includes(res.status), `${evil} → ${res.status}`);
      assert.ok(!String(res.text).includes('SQLite format'), evil);
    }
    // Les noms contenant des séparateurs de chemin sont refusés à la création.
    await admin.agent.post('/api/folders').set('X-CSRF-Token', admin.csrf).send({ parentId: coursId, name: '../../etc' }).expect(400);
    await admin.agent.post('/api/folders').set('X-CSRF-Token', admin.csrf).send({ parentId: coursId, name: '..' }).expect(400);
    // Un nom de fichier « ../../x.pdf » est réduit à son nom de base ou refusé.
    for (const evil of ['../../evil.pdf', '..\\..\\evil.pdf']) {
      const res = await upload(evil);
      if (res.status === 201) assert.doesNotMatch(res.body.files[0].name, /[\\/]|\.\./);
      else assert.ok([400, 415].includes(res.status), `${evil} → ${res.status}`);
    }
  });

  test('renommage : extension figée, nom unique', async () => {
    const a = (await upload('a.pdf').expect(201)).body.files[0];
    await upload('b.pdf').expect(201);
    const patch = (name) => admin.agent.patch(`/api/files/${a.id}`).set('X-CSRF-Token', admin.csrf).send({ name });
    await patch('a.html').expect(400);
    await patch('B.pdf').expect(409);
    await patch('c.pdf').expect(200);
  });

  test('suppression récursive d’un dossier (base + disque)', async () => {
    const created = await admin.agent.post('/api/folders').set('X-CSRF-Token', admin.csrf).send({ parentId: coursId, name: 'À supprimer' }).expect(201);
    const res = await admin.agent
      .post(`/api/folders/${created.body.id}/files`)
      .set('X-CSRF-Token', admin.csrf)
      .attach('files', PDF, 'x.pdf')
      .expect(201);
    const blob = path.join(ctx.config.filesDir, res.body.files[0].id);
    assert.ok(fs.existsSync(blob));
    await admin.agent.delete(`/api/folders/${created.body.id}`).set('X-CSRF-Token', admin.csrf).expect(200);
    assert.ok(!fs.existsSync(blob));
    await request(ctx.app).get(`/api/folders/${created.body.id}`).expect(404);
  });

  test('recherche insensible aux accents', async () => {
    const res = await request(ctx.app).get('/api/search?q=integrales').expect(200);
    assert.ok(res.body.files.some((f) => f.name === 'Cours – intégrales.pdf'));
    assert.equal(res.body.files[0].path, 'TSI1 / Maths / Cours');
  });
});

describe('en-têtes de sécurité', () => {
  let ctx;
  before(async () => (ctx = await setup()));
  after(() => fs.rmSync(ctx.dataDir, { recursive: true, force: true }));

  test('CSP stricte sur la page', async () => {
    const res = await request(ctx.app).get('/').expect(200);
    const csp = res.headers['content-security-policy'];
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    assert.equal(res.headers['x-powered-by'], undefined);
  });
});
