'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const contentDisposition = require('content-disposition');
const { requireAdmin, HttpError } = require('../security');
const {
  sanitizeName,
  extensionOf,
  mimeFor,
  isInline,
  matchesSignature,
  removeQuietly,
  UUID_RE,
} = require('../storage');
const { parseId, isUniqueViolation } = require('./folders');

function fileRoutes({ db, config, blobs }) {
  const router = express.Router();
  const folderRouter = express.Router();

  const stmt = {
    get: db.prepare('SELECT id, folder_id, name, size, mime, created_at FROM files WHERE id = ?'),
    folderExists: db.prepare('SELECT 1 FROM folders WHERE id = ?'),
    nameTaken: db.prepare('SELECT 1 FROM files WHERE folder_id = ? AND name = ? COLLATE NOCASE'),
    insert: db.prepare(
      'INSERT INTO files (id, folder_id, name, size, mime, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    rename: db.prepare('UPDATE files SET name = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM files WHERE id = ?'),
    breadcrumb: db.prepare(`
      WITH RECURSIVE chain(id, parent_id, name, depth) AS (
        SELECT id, parent_id, name, 0 FROM folders WHERE id = ?
        UNION ALL
        SELECT f.id, f.parent_id, f.name, c.depth + 1 FROM folders f JOIN chain c ON f.id = c.parent_id
      )
      SELECT id, name FROM chain ORDER BY depth DESC`),
  };

  function loadFile(id) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) throw new HttpError(404, 'Fichier introuvable.');
    const file = stmt.get.get(id);
    if (!file) throw new HttpError(404, 'Fichier introuvable.');
    return file;
  }

  function checkExtension(name) {
    const ext = extensionOf(name);
    if (!ext || !config.allowedExtensions.has(ext)) {
      throw new HttpError(415, `Type de fichier non autorisé : « ${name} ».`);
    }
  }

  /** « Cours.pdf » → « Cours (2).pdf » si le nom est déjà pris dans le dossier. */
  function uniqueName(folderId, name) {
    if (!stmt.nameTaken.get(folderId, name)) return name;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})${ext}`;
      if (!stmt.nameTaken.get(folderId, candidate)) return candidate;
    }
    throw new HttpError(409, 'Trop de fichiers portent ce nom.');
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: config.tmpDir,
      filename: (_req, _file, cb) => cb(null, `upload-${crypto.randomUUID()}`),
    }),
    defParamCharset: 'utf8', // noms de fichiers accentués correctement décodés
    limits: {
      fileSize: config.maxUploadBytes,
      files: config.maxFilesPerUpload,
      fields: 5,
      parts: config.maxFilesPerUpload + 5,
    },
    fileFilter: (_req, file, cb) => {
      try {
        checkExtension(sanitizeName(file.originalname));
        cb(null, true);
      } catch (err) {
        cb(err);
      }
    },
  });

  // --- Upload : POST /api/folders/:id/files (multipart, champ "files") ---------------
  // L'authentification admin et le CSRF sont vérifiés AVANT que multer ne lise le corps.
  folderRouter.post(
    '/:id/files',
    requireAdmin,
    (req, _res, next) => {
      req.folderId = parseId(req.params.id);
      if (!stmt.folderExists.get(req.folderId)) return next(new HttpError(404, 'Dossier introuvable.'));
      next();
    },
    (req, res, next) => {
      upload.array('files', config.maxFilesPerUpload)(req, res, (err) => {
        if (err) {
          for (const f of req.files || []) removeQuietly(f.path);
          if (err instanceof multer.MulterError) {
            const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
            const message =
              err.code === 'LIMIT_FILE_SIZE'
                ? `Fichier trop volumineux (max ${Math.round(config.maxUploadBytes / 1048576)} Mo).`
                : `Envoi refusé (${err.code}).`;
            return next(new HttpError(status, message));
          }
          return next(err);
        }
        next();
      });
    },
    (req, res) => {
      const files = req.files || [];
      if (files.length === 0) throw new HttpError(400, 'Aucun fichier reçu.');

      const created = [];
      const rejected = [];
      try {
        for (const f of files) {
          const name = sanitizeName(f.originalname);
          if (!matchesSignature(f.path, name)) {
            rejected.push({ name, error: 'Le contenu ne correspond pas à l’extension du fichier.' });
            removeQuietly(f.path);
            continue;
          }
          const id = crypto.randomUUID();
          const finalName = uniqueName(req.folderId, name);
          blobs.store(f.path, id);
          try {
            stmt.insert.run(id, req.folderId, finalName, f.size, mimeFor(finalName), req.user.id, Date.now());
          } catch (err) {
            blobs.remove(id);
            throw err;
          }
          created.push({ id, name: finalName, size: f.size });
        }
      } finally {
        for (const f of files) removeQuietly(f.path); // fichiers temporaires restants
      }
      res.status(created.length ? 201 : 400).json({
        files: created,
        rejected,
        ...(created.length ? {} : { error: rejected[0] ? rejected[0].error : 'Aucun fichier valide.' }),
      });
    },
  );

  // --- Métadonnées -------------------------------------------------------------------
  router.get('/:id', (req, res) => {
    const file = loadFile(req.params.id);
    res.json({
      file: {
        id: file.id,
        name: file.name,
        size: file.size,
        mime: file.mime,
        created_at: file.created_at,
        folderId: file.folder_id,
        inline: isInline(file.name),
      },
      breadcrumb: stmt.breadcrumb.all(file.folder_id),
    });
  });

  // --- Contenu : /view (inline si type sûr) et /download (toujours en pièce jointe) ----
  function send(disposition) {
    return (req, res, next) => {
      const file = loadFile(req.params.id);
      const inline = disposition === 'inline' && isInline(file.name);
      res.sendFile(
        blobs.blobPath(file.id),
        {
          headers: {
            'Content-Type': inline ? mimeFor(file.name) : 'application/octet-stream',
            'Content-Disposition': contentDisposition(file.name, { type: inline ? 'inline' : 'attachment' }),
            'Cache-Control': config.publicRead ? 'public, max-age=0, must-revalidate' : 'private, no-cache',
            'X-Content-Type-Options': 'nosniff',
            // Seuls PDF et images matricielles (signature vérifiée) sont servis inline, avec la
            // CSP globale ; tout le reste est un téléchargement isolé dans un bac à sable.
            ...(inline ? {} : { 'Content-Security-Policy': "default-src 'none'; sandbox" }),
          },
          lastModified: true,
          acceptRanges: true, // permet à PDF.js de charger les gros PDF par morceaux
        },
        (err) => {
          if (err && !res.headersSent) {
            next(err.code === 'ENOENT' ? new HttpError(404, 'Fichier absent du stockage.') : err);
          }
        },
      );
    };
  }
  router.get('/:id/view', send('inline'));
  router.get('/:id/download', send('attachment'));

  // --- Renommage / suppression (admin) ------------------------------------------------
  router.patch('/:id', requireAdmin, (req, res) => {
    const file = loadFile(req.params.id);
    const name = sanitizeName((req.body || {}).name);
    if (extensionOf(name) !== extensionOf(file.name)) {
      throw new HttpError(400, 'L’extension du fichier ne peut pas être modifiée.');
    }
    try {
      stmt.rename.run(name, file.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'Un fichier porte déjà ce nom ici.');
      throw err;
    }
    res.json({ id: file.id, name });
  });

  router.delete('/:id', requireAdmin, (req, res) => {
    const file = loadFile(req.params.id);
    stmt.remove.run(file.id);
    blobs.remove(file.id);
    res.json({ ok: true });
  });

  return { fileRouter: router, folderUploadRouter: folderRouter };
}

module.exports = { fileRoutes };
