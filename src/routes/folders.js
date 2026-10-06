'use strict';

const express = require('express');
const { requireAdmin, HttpError } = require('../security');
const { sanitizeName } = require('../storage');

function parseId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  throw new HttpError(400, 'Identifiant de dossier invalide.');
}

function isUniqueViolation(err) {
  return err && err.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function folderRoutes({ db, blobs }) {
  const router = express.Router();

  const stmt = {
    get: db.prepare('SELECT id, parent_id, name, created_at FROM folders WHERE id = ?'),
    breadcrumb: db.prepare(`
      WITH RECURSIVE chain(id, parent_id, name, depth) AS (
        SELECT id, parent_id, name, 0 FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id, f.parent_id, f.name, c.depth + 1 FROM folders f JOIN chain c ON f.id = c.parent_id
      )
      SELECT id, name FROM chain ORDER BY depth DESC`),
    children: db.prepare(`
      SELECT f.id, f.name, f.created_at,
        (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id)
          + (SELECT COUNT(*) FROM files x WHERE x.folder_id = f.id) AS items
      FROM folders f WHERE f.parent_id IS ?`),
    files: db.prepare('SELECT id, name, size, mime, created_at FROM files WHERE folder_id = ?'),
    insert: db.prepare('INSERT INTO folders (parent_id, name, created_at) VALUES (?, ?, ?)'),
    rename: db.prepare('UPDATE folders SET name = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM folders WHERE id = ?'),
    subtreeFiles: db.prepare(`
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
      )
      SELECT files.id FROM files JOIN tree ON files.folder_id = tree.id`),
  };

  function loadFolder(id) {
    const folder = stmt.get.get(id);
    if (!folder) throw new HttpError(404, 'Dossier introuvable.');
    return folder;
  }

  // Contenu de la racine (les années).
  router.get('/root', (_req, res) => {
    res.json({ folder: null, breadcrumb: [], folders: stmt.children.all(null), files: [] });
  });

  router.get('/:id', (req, res) => {
    const folder = loadFolder(parseId(req.params.id));
    res.json({
      folder: { id: folder.id, name: folder.name, parentId: folder.parent_id },
      breadcrumb: stmt.breadcrumb.all(folder.id),
      folders: stmt.children.all(folder.id),
      files: stmt.files.all(folder.id),
    });
  });

  router.post('/', requireAdmin, (req, res) => {
    const { parentId, name } = req.body || {};
    const parent = parentId === null || parentId === undefined ? null : loadFolder(parseId(parentId)).id;
    const clean = sanitizeName(name, { maxLength: 120 });
    try {
      const id = stmt.insert.run(parent, clean, Date.now()).lastInsertRowid;
      res.status(201).json({ id: Number(id), name: clean });
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Un dossier porte déjà ce nom ici.');
      throw err;
    }
  });

  router.patch('/:id', requireAdmin, (req, res) => {
    const folder = loadFolder(parseId(req.params.id));
    const clean = sanitizeName((req.body || {}).name, { maxLength: 120 });
    try {
      stmt.rename.run(clean, folder.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Un dossier porte déjà ce nom ici.');
      throw err;
    }
    res.json({ id: folder.id, name: clean });
  });

  // Suppression récursive : sous-dossiers et fichiers (en base par cascade, sur disque ensuite).
  router.delete('/:id', requireAdmin, (req, res) => {
    const folder = loadFolder(parseId(req.params.id));
    const fileIds = db.transaction(() => {
      const ids = stmt.subtreeFiles.all(folder.id).map((r) => r.id);
      stmt.remove.run(folder.id);
      return ids;
    })();
    for (const id of fileIds) blobs.remove(id);
    res.json({ ok: true, deletedFiles: fileIds.length });
  });

  return router;
}

/** Recherche plein-texte simple sur les noms de dossiers et de fichiers. */
function searchRoute({ db }) {
  const allFolders = db.prepare('SELECT id, parent_id, name FROM folders');
  const findFolders = db.prepare(
    "SELECT id, name FROM folders WHERE fold(name) LIKE fold(?) ESCAPE '\\' ORDER BY name LIMIT 30",
  );
  const findFiles = db.prepare(
    "SELECT id, folder_id, name, size, mime, created_at FROM files WHERE fold(name) LIKE fold(?) ESCAPE '\\' ORDER BY name LIMIT 100",
  );

  return (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    if (q.length < 2) return res.json({ folders: [], files: [] });

    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const byId = new Map(allFolders.all().map((f) => [f.id, f]));
    const pathOf = (id) => {
      const parts = [];
      for (let f = byId.get(id); f && parts.length < 64; f = byId.get(f.parent_id)) parts.unshift(f.name);
      return parts.join(' / ');
    };

    res.json({
      folders: findFolders.all(pattern).map((f) => ({ ...f, path: pathOf(f.id) })),
      files: findFiles.all(pattern).map((f) => ({
        id: f.id,
        name: f.name,
        size: f.size,
        mime: f.mime,
        created_at: f.created_at,
        folderId: f.folder_id,
        path: pathOf(f.folder_id),
      })),
    });
  };
}

module.exports = { folderRoutes, searchRoute, parseId, isUniqueViolation };
