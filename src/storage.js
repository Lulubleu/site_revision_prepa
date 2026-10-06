'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./security');

const MIME_TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  tex: 'text/x-tex; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  ipynb: 'application/x-ipynb+json',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  zip: 'application/zip',
};

// Signatures (« magic bytes ») vérifiées pour les types affichés dans le navigateur
// ou dont le contenu doit correspondre à l'extension.
const SIGNATURES = {
  pdf: [Buffer.from('%PDF-')],
  png: [Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  jpg: [Buffer.from([0xff, 0xd8, 0xff])],
  jpeg: [Buffer.from([0xff, 0xd8, 0xff])],
  gif: [Buffer.from('GIF87a'), Buffer.from('GIF89a')],
  webp: [Buffer.from('RIFF')],
  zip: [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])],
};
for (const ext of ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp']) SIGNATURES[ext] = SIGNATURES.zip;

// Seuls ces types sont servis « inline » ; tout le reste part en téléchargement.
const INLINE_TYPES = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Caractères de contrôle, séparateurs de chemin et caractères interdits sous Windows.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f/\\<>:"|?*]/;

/** Valide et normalise un nom de fichier ou de dossier saisi par l'utilisateur. */
function sanitizeName(raw, { maxLength = 180 } = {}) {
  if (typeof raw !== 'string') throw new HttpError(400, 'Nom invalide.');
  const name = raw.normalize('NFC').trim();
  if (!name) throw new HttpError(400, 'Le nom ne peut pas être vide.');
  if (name.length > maxLength) throw new HttpError(400, `Nom trop long (${maxLength} caractères max).`);
  if (name === '.' || name === '..' || /^\.+$/.test(name)) throw new HttpError(400, 'Nom invalide.');
  if (FORBIDDEN_CHARS.test(name)) {
    throw new HttpError(400, 'Le nom contient des caractères interdits (/ \\ < > : " | ? *).');
  }
  return name;
}

function extensionOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return ext;
}

function mimeFor(name) {
  return MIME_TYPES[extensionOf(name)] || 'application/octet-stream';
}

function isInline(name) {
  return INLINE_TYPES.has(extensionOf(name));
}

function readHead(filePath, length = 16) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Vérifie que le contenu correspond à l'extension déclarée (quand une signature est connue). */
function matchesSignature(filePath, name) {
  const signatures = SIGNATURES[extensionOf(name)];
  if (!signatures) return true;
  if (extensionOf(name) === 'pdf') {
    // Certains PDF ont quelques octets parasites avant l'en-tête : on tolère jusqu'à 1 Kio.
    return readHead(filePath, 1024).includes(signatures[0]);
  }
  const head = readHead(filePath);
  return signatures.some((sig) => head.subarray(0, sig.length).equals(sig));
}

function createBlobStore(config) {
  fs.mkdirSync(config.filesDir, { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
  const root = path.resolve(config.filesDir);

  /**
   * Chemin du fichier sur disque. L'identifiant est un UUID généré par le serveur,
   * validé par regex, et le chemin résolu est en plus vérifié contre la racine :
   * aucun nom fourni par l'utilisateur n'intervient jamais dans un chemin disque.
   */
  function blobPath(id) {
    if (!UUID_RE.test(id)) throw new HttpError(404, 'Fichier introuvable.');
    const resolved = path.resolve(root, id);
    if (path.dirname(resolved) !== root) throw new HttpError(404, 'Fichier introuvable.');
    return resolved;
  }

  return {
    root,
    blobPath,
    store(tmpPath, id) {
      fs.renameSync(tmpPath, blobPath(id));
    },
    remove(id) {
      try {
        fs.unlinkSync(blobPath(id));
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Suppression de ${id} impossible :`, err.message);
      }
    },
  };
}

function removeQuietly(filePath) {
  if (!filePath) return;
  fs.rm(filePath, { force: true }, () => {});
}

module.exports = {
  sanitizeName,
  extensionOf,
  mimeFor,
  isInline,
  matchesSignature,
  createBlobStore,
  removeQuietly,
  UUID_RE,
};
