import {
  state,
  api,
  ApiError,
  uploadWithProgress,
  h,
  icon,
  fileKind,
  formatSize,
  formatDate,
  byName,
  plural,
  toast,
  openDialog,
  openMenu,
} from './lib.js';
import { openViewer, closeViewer, isViewerOpen } from './viewer.js';
import { observeThumb } from './thumbs.js';

const main = document.getElementById('main');
const accountBox = document.getElementById('account');
const searchInput = document.getElementById('search-input');

let current = null; // { folder, breadcrumb, folders, files } affiché
let viewMode = readPref('viewMode', 'grid');

const isAdmin = () => state.user && state.user.role === 'admin';
const canRead = () => state.publicRead || !!state.user;

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* stockage indisponible */
  }
}

// ---------------------------------------------------------------------------
// Routage (History API) : /  ·  /d/:id  ·  /f/:uuid  ·  ?q=recherche
// ---------------------------------------------------------------------------

function navigate(url, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  route();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', route);

async function route() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);

  if (!canRead()) {
    closeViewer();
    return renderLoginScreen();
  }

  const fileMatch = path.match(/^\/f\/([0-9a-f-]{36})\/?$/);
  if (fileMatch) return showFile(fileMatch[1]);
  closeViewer();

  const q = params.get('q');
  if (q) {
    searchInput.value = q;
    return renderSearch(q);
  }

  const folderMatch = path.match(/^\/d\/(\d+)\/?$/);
  return loadFolder(folderMatch ? Number(folderMatch[1]) : null);
}

async function loadFolder(id, { keepScroll = false } = {}) {
  const scroll = window.scrollY;
  try {
    const data = await api('GET', id ? `/api/folders/${id}` : '/api/folders/root');
    current = data;
    renderFolder(data);
    document.title = `${data.folder ? data.folder.name : 'Accueil'} · ${state.siteTitle}`;
    if (keepScroll) window.scrollTo(0, scroll);
  } catch (err) {
    handleError(err, () => renderMessage('Dossier introuvable', 'Ce dossier n’existe pas ou a été supprimé.'));
  }
}

const refresh = () => (current ? loadFolder(current.folder ? current.folder.id : null, { keepScroll: true }) : route());

async function showFile(id) {
  try {
    const { file, breadcrumb } = await api('GET', `/api/files/${id}`);
    // Affiche le dossier parent derrière la visionneuse (utile en accès direct par lien).
    if (!current || !current.folder || current.folder.id !== file.folderId) {
      await loadFolder(file.folderId);
    }
    document.title = `${file.name} · ${state.siteTitle}`;
    openViewer(file, {
      breadcrumb,
      onClose: () => {
        if (history.state && history.state.fromApp) history.back();
        else navigate(`/d/${file.folderId}`, { replace: true });
      },
    });
  } catch (err) {
    handleError(err, () => {
      toast('Fichier introuvable.', 'error');
      navigate('/', { replace: true });
    });
  }
}

function openFile(file) {
  history.pushState({ fromApp: true }, '', `/f/${file.id}`);
  route();
}

function handleError(err, fallback) {
  if (err instanceof ApiError && err.status === 401) {
    state.user = null;
    state.csrfToken = null;
    renderAccount();
    if (!state.publicRead) return renderLoginScreen();
    toast('Votre session a expiré. Reconnectez-vous.', 'error');
    return;
  }
  if (fallback && err instanceof ApiError && err.status === 404) return fallback();
  toast(err.message || 'Une erreur est survenue.', 'error');
}

// ---------------------------------------------------------------------------
// Rendu d'un dossier
// ---------------------------------------------------------------------------

function renderBreadcrumb(breadcrumb, { trailing } = {}) {
  const items = [h('li', {}, h('a', { href: '/', 'data-link': true, title: 'Accueil' }, icon('home'), 'Accueil'))];
  breadcrumb.forEach((b, i) => {
    const last = i === breadcrumb.length - 1 && !trailing;
    items.push(
      h(
        'li',
        {},
        icon('chevron', 'sep'),
        last
          ? h('span', { class: 'current', 'aria-current': 'page' }, b.name)
          : h('a', { href: `/d/${b.id}`, 'data-link': true }, b.name),
      ),
    );
  });
  if (trailing) items.push(h('li', {}, icon('chevron', 'sep'), h('span', { class: 'current' }, trailing)));
  if (!breadcrumb.length && !trailing) {
    items[0] = h('li', {}, h('span', { class: 'current' }, icon('home'), 'Accueil'));
  }
  return h('nav', { 'aria-label': 'Fil d’Ariane' }, h('ol', { class: 'breadcrumb' }, items));
}

function renderToolbar(data) {
  const tools = [];
  if (isAdmin()) {
    const isRoot = !data.folder;
    tools.push(
      h(
        'button',
        { class: 'btn', type: 'button', onclick: () => createFolder(data.folder) },
        icon('folder-plus'),
        h('span', { class: 'lbl' }, isRoot ? 'Nouvelle année' : 'Nouveau dossier'),
      ),
    );
    if (!isRoot) {
      tools.push(
        h(
          'button',
          { class: 'btn btn-primary', type: 'button', onclick: () => pickFiles(data.folder) },
          icon('upload'),
          h('span', { class: 'lbl' }, 'Importer'),
        ),
      );
    }
  }
  if (data.files.length) {
    const toggle = (mode, ic, label) =>
      h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: label,
          'aria-label': label,
          'aria-pressed': String(viewMode === mode),
          onclick: () => {
            viewMode = mode;
            writePref('viewMode', mode);
            renderFolder(current);
          },
        },
        icon(ic),
      );
    tools.push(h('div', { class: 'view-toggle' }, toggle('grid', 'grid', 'Vue grille'), toggle('list', 'list', 'Vue liste')));
  }
  return h('div', { class: 'toolbar' }, tools);
}

function renderFolder(data) {
  const folders = [...data.folders].sort(byName);
  const files = [...data.files].sort(byName);
  const isRoot = !data.folder;
  const content = [];

  if (folders.length) {
    content.push(h('h2', { class: 'section-title' }, isRoot ? 'Années' : 'Dossiers'));
    content.push(h('div', { class: 'folder-grid' }, folders.map((f) => folderCard(f, isRoot))));
  }
  if (files.length) {
    content.push(h('h2', { class: 'section-title' }, 'Fichiers'));
    content.push(viewMode === 'list' ? fileTable(files) : h('div', { class: 'file-grid' }, files.map(fileCard)));
  }
  if (!folders.length && !files.length) {
    content.push(
      h(
        'div',
        { class: 'empty' },
        icon(isRoot ? 'folder' : 'upload'),
        h('strong', {}, isRoot ? 'Aucune année pour le moment' : 'Ce dossier est vide'),
        isAdmin() && !isRoot
          ? h('span', {}, 'Glissez-déposez des fichiers ici ou utilisez le bouton « Importer ».')
          : isAdmin()
            ? h('span', {}, 'Créez une année avec « Nouvelle année ».')
            : null,
      ),
    );
  }

  main.replaceChildren(h('div', { class: 'page-head' }, renderBreadcrumb(data.breadcrumb), renderToolbar(data)), ...content);
}

function folderCard(folder, large) {
  const actions = isAdmin()
    ? h(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          'aria-label': `Actions pour ${folder.name}`,
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.currentTarget, [
              { label: 'Renommer', icon: 'edit', onClick: () => renameFolder(folder) },
              { label: 'Supprimer', icon: 'trash', danger: true, onClick: () => deleteFolder(folder) },
            ]);
          },
        },
        icon('more'),
      )
    : null;
  return h(
    'a',
    { class: `folder-card${large ? ' large' : ''}`, href: `/d/${folder.id}`, 'data-link': true },
    icon('folder', 'icon'),
    h('div', { class: 'meta' }, h('div', { class: 'name' }, folder.name), h('div', { class: 'sub' }, folder.items ? plural(folder.items, 'élément', 'éléments') : 'Vide')),
    actions,
  );
}

function fileMenu(file, anchor) {
  const items = [
    { label: 'Ouvrir', icon: 'external', onClick: () => openFile(file) },
    { label: 'Télécharger', icon: 'download', onClick: () => downloadFile(file) },
  ];
  if (isAdmin()) {
    items.push(
      { label: 'Renommer', icon: 'edit', onClick: () => renameFile(file) },
      { label: 'Supprimer', icon: 'trash', danger: true, onClick: () => deleteFile(file) },
    );
  }
  openMenu(anchor, items);
}

function moreButton(file) {
  return h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      'aria-label': `Actions pour ${file.name}`,
      onclick: (e) => {
        e.stopPropagation();
        fileMenu(file, e.currentTarget);
      },
    },
    icon('more'),
  );
}

function downloadButton(file) {
  return h(
    'a',
    {
      class: 'icon-btn',
      href: `/api/files/${file.id}/download`,
      download: '',
      title: 'Télécharger',
      'aria-label': `Télécharger ${file.name}`,
      onclick: (e) => e.stopPropagation(),
    },
    icon('download'),
  );
}

function fileCard(file) {
  const kind = fileKind(file.name);
  const thumb = h('div', { class: `thumb kind-${kind}` }, icon(kind));
  observeThumb(thumb, file, kind);
  return h(
    'div',
    {
      class: 'file-card',
      tabindex: 0,
      role: 'button',
      'aria-label': `Ouvrir ${file.name}`,
      onclick: () => openFile(file),
      onkeydown: (e) => e.key === 'Enter' && openFile(file),
    },
    thumb,
    h(
      'div',
      { class: 'info' },
      icon(kind, `ficon kind-${kind}`),
      h('div', { class: 'text' }, h('div', { class: 'name', title: file.name }, file.name), h('div', { class: 'sub' }, `${formatSize(file.size)} · ${formatDate(file.created_at)}`)),
      isAdmin() ? moreButton(file) : downloadButton(file),
    ),
  );
}

function fileTable(files, { showPath = false } = {}) {
  return h(
    'table',
    { class: 'file-table' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Nom'), h('th', { class: 'col-size' }, 'Taille'), h('th', { class: 'col-date' }, 'Ajouté le'), h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, 'Actions')))),
    h(
      'tbody',
      {},
      files.map((file) => {
        const kind = fileKind(file.name);
        return h(
          'tr',
          { tabindex: 0, onclick: () => openFile(file), onkeydown: (e) => e.key === 'Enter' && openFile(file) },
          h('td', {}, h('div', { class: 'name-cell' }, icon(kind, `kind-${kind}`), h('span', { title: file.name }, file.name, showPath ? h('small', { class: 'path' }, file.path) : null))),
          h('td', { class: 'col-size' }, formatSize(file.size)),
          h('td', { class: 'col-date' }, formatDate(file.created_at)),
          h('td', { class: 'col-actions' }, downloadButton(file), moreButton(file)),
        );
      }),
    ),
  );
}

function renderMessage(title, text) {
  main.replaceChildren(h('div', { class: 'empty' }, icon('alert'), h('strong', {}, title), h('span', {}, text), h('a', { class: 'btn', href: '/', 'data-link': true }, 'Retour à l’accueil')));
}

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------

let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = searchInput.value.trim();
    if (q.length >= 2) navigate(`/?q=${encodeURIComponent(q)}`, { replace: new URLSearchParams(location.search).has('q') });
    else if (!q && new URLSearchParams(location.search).has('q')) navigate('/', { replace: true });
  }, 250);
});
document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = searchInput.value.trim();
  if (q.length >= 2) navigate(`/?q=${encodeURIComponent(q)}`);
});

async function renderSearch(q) {
  try {
    const data = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    current = null;
    document.title = `Recherche · ${state.siteTitle}`;
    const content = [];
    if (data.folders.length) {
      content.push(h('h2', { class: 'section-title' }, 'Dossiers'));
      content.push(
        h(
          'div',
          { class: 'folder-grid' },
          data.folders.map((f) =>
            h('a', { class: 'folder-card', href: `/d/${f.id}`, 'data-link': true }, icon('folder', 'icon'), h('div', { class: 'meta' }, h('div', { class: 'name' }, f.name), h('div', { class: 'sub' }, f.path))),
          ),
        ),
      );
    }
    if (data.files.length) {
      content.push(h('h2', { class: 'section-title' }, 'Fichiers'));
      content.push(fileTable(data.files, { showPath: true }));
    }
    if (!content.length) {
      content.push(h('div', { class: 'empty' }, icon('search'), h('strong', {}, 'Aucun résultat'), h('span', {}, `Rien ne correspond à « ${q} ».`)));
    }
    main.replaceChildren(h('div', { class: 'page-head' }, renderBreadcrumb([], { trailing: `Recherche : « ${q} »` })), ...content);
  } catch (err) {
    handleError(err);
  }
}

// ---------------------------------------------------------------------------
// Actions administrateur
// ---------------------------------------------------------------------------

async function createFolder(parent) {
  const created = await openDialog({
    title: parent ? 'Nouveau dossier' : 'Nouvelle année',
    message: parent ? `Dans « ${parent.name} »` : 'Créée à la racine (ex. TSI3, Archives 2025…)',
    fields: [{ name: 'name', label: 'Nom', maxlength: 120 }],
    submitLabel: 'Créer',
    onSubmit: ({ name }) => api('POST', '/api/folders', { parentId: parent ? parent.id : null, name }),
  });
  if (created) {
    toast(`Dossier « ${created.name} » créé.`);
    refresh();
  }
}

async function renameFolder(folder) {
  const done = await openDialog({
    title: 'Renommer le dossier',
    fields: [{ name: 'name', label: 'Nom', value: folder.name, maxlength: 120 }],
    submitLabel: 'Renommer',
    onSubmit: ({ name }) => api('PATCH', `/api/folders/${folder.id}`, { name }),
  });
  if (done) refresh();
}

async function deleteFolder(folder) {
  const done = await openDialog({
    title: 'Supprimer le dossier ?',
    message: `« ${folder.name} » et tout son contenu (${plural(folder.items, 'élément direct', 'éléments directs')}) seront définitivement supprimés.`,
    submitLabel: 'Supprimer',
    danger: true,
    onSubmit: () => api('DELETE', `/api/folders/${folder.id}`),
  });
  if (done) {
    toast('Dossier supprimé.');
    refresh();
  }
}

async function renameFile(file) {
  const done = await openDialog({
    title: 'Renommer le fichier',
    fields: [{ name: 'name', label: 'Nom', value: file.name, maxlength: 180 }],
    submitLabel: 'Renommer',
    onSubmit: ({ name }) => api('PATCH', `/api/files/${file.id}`, { name }),
  });
  if (done) refresh();
}

async function deleteFile(file) {
  const done = await openDialog({
    title: 'Supprimer le fichier ?',
    message: `« ${file.name} » sera définitivement supprimé.`,
    submitLabel: 'Supprimer',
    danger: true,
    onSubmit: () => api('DELETE', `/api/files/${file.id}`),
  });
  if (done) {
    toast('Fichier supprimé.');
    if (isViewerOpen()) closeViewer();
    refresh();
  }
}

function downloadFile(file) {
  const a = h('a', { href: `/api/files/${file.id}/download`, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---------------------------------------------------------------------------
// Upload : bouton + glisser-déposer, avec progression
// ---------------------------------------------------------------------------

function pickFiles(folder) {
  const input = h('input', { type: 'file', multiple: true });
  input.addEventListener('change', () => uploadFiles(folder, [...input.files]));
  input.click();
}

const uploadsBox = document.getElementById('uploads');
let uploadsList = null;

function uploadPanel() {
  if (!uploadsList) {
    uploadsList = h('ul', { class: 'uploads-list' });
    const closeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fermer', onclick: () => { uploadsBox.hidden = true; uploadsList.replaceChildren(); } }, icon('close'));
    uploadsBox.replaceChildren(h('div', { class: 'uploads-head' }, h('span', {}, 'Envois'), closeBtn), uploadsList);
  }
  uploadsBox.hidden = false;
  return uploadsList;
}

async function uploadFiles(folder, files) {
  if (!files.length) return;
  const list = uploadPanel();
  let okCount = 0;
  // Un fichier par requête : progression individuelle et un échec n'annule pas les autres.
  for (const file of files) {
    const status = h('span', { class: 'ustatus' }, 'En attente…');
    const bar = h('div');
    const row = h('li', { class: 'upload-item' }, icon(fileKind(file.name), `kind-${fileKind(file.name)}`), h('span', { class: 'uname', title: file.name }, file.name), status, h('div', { class: 'progress' }, bar));
    list.prepend(row);
    const fd = new FormData();
    fd.append('files', file, file.name);
    try {
      const res = await uploadWithProgress(`/api/folders/${folder.id}/files`, fd, (p) => {
        bar.style.width = `${Math.round(p * 100)}%`;
        status.textContent = `${Math.round(p * 100)} %`;
      });
      bar.style.width = '100%';
      if (res.files && res.files.length) {
        okCount++;
        status.textContent = 'Terminé';
        status.className = 'ustatus ok';
      } else {
        throw new Error((res.rejected && res.rejected[0] && res.rejected[0].error) || 'Refusé');
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return handleError(err);
      status.textContent = err.message;
      status.className = 'ustatus err';
      status.title = err.message;
    }
  }
  if (okCount) {
    toast(`${plural(okCount, 'fichier importé', 'fichiers importés')}.`);
    if (current && current.folder && current.folder.id === folder.id) refresh();
  }
}

// Glisser-déposer sur toute la fenêtre (admin, dans un dossier).
const overlay = document.getElementById('drop-overlay');
let dragDepth = 0;
const dropAllowed = (e) => isAdmin() && current && current.folder && !isViewerOpen() && e.dataTransfer && [...e.dataTransfer.types].includes('Files');

window.addEventListener('dragenter', (e) => {
  if (!dropAllowed(e)) return;
  e.preventDefault();
  dragDepth++;
  document.getElementById('drop-target').textContent = `dans « ${current.folder.name} »`;
  overlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!dropAllowed(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!dropAllowed(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) overlay.hidden = true;
});
window.addEventListener('drop', (e) => {
  overlay.hidden = true;
  dragDepth = 0;
  if (!dropAllowed(e)) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  if (files.length) uploadFiles(current.folder, files);
});

// ---------------------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------------------

async function login(values) {
  const res = await api('POST', '/api/auth/login', { username: values.username, password: values.password });
  state.user = res.user;
  state.csrfToken = res.csrfToken;
  renderAccount();
  toast(`Bienvenue, ${res.user.username} !`);
  return res;
}

function loginFields() {
  return [
    { name: 'username', label: 'Identifiant', autocomplete: 'username', maxlength: 64 },
    { name: 'password', label: 'Mot de passe', type: 'password', autocomplete: 'current-password', maxlength: 256 },
  ];
}

async function openLogin() {
  const res = await openDialog({ title: 'Connexion', fields: loginFields(), submitLabel: 'Se connecter', onSubmit: login });
  if (res) route();
}

function renderLoginScreen() {
  const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
  const user = h('input', { id: 'l-user', name: 'username', autocomplete: 'username', required: true, maxlength: 64 });
  const pass = h('input', { id: 'l-pass', name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxlength: 256 });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Se connecter');
  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        submit.disabled = true;
        errorBox.hidden = true;
        try {
          await login({ username: user.value, password: pass.value });
          route();
        } catch (err) {
          errorBox.replaceChildren(icon('alert'), err.message);
          errorBox.hidden = false;
          submit.disabled = false;
        }
      },
    },
    h('h1', {}, icon('lock'), 'Accès réservé'),
    h('p', {}, 'Connectez-vous pour consulter les cours.'),
    h('div', { class: 'field' }, h('label', { for: 'l-user' }, 'Identifiant'), user),
    h('div', { class: 'field' }, h('label', { for: 'l-pass' }, 'Mot de passe'), pass),
    errorBox,
    submit,
  );
  main.replaceChildren(h('div', { class: 'login-screen' }, h('div', { class: 'login-card' }, form)));
  user.focus();
}

async function changePassword() {
  const done = await openDialog({
    title: 'Changer le mot de passe',
    fields: [
      { name: 'currentPassword', label: 'Mot de passe actuel', type: 'password', autocomplete: 'current-password', maxlength: 256 },
      { name: 'newPassword', label: 'Nouveau mot de passe (10 caractères min.)', type: 'password', autocomplete: 'new-password', maxlength: 256 },
      { name: 'confirm', label: 'Confirmation', type: 'password', autocomplete: 'new-password', maxlength: 256 },
    ],
    submitLabel: 'Enregistrer',
    onSubmit: (v) => {
      if (v.newPassword !== v.confirm) throw new Error('Les deux mots de passe ne correspondent pas.');
      return api('POST', '/api/auth/password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
    },
  });
  if (done) toast('Mot de passe modifié. Les autres sessions ont été déconnectées.');
}

async function logout() {
  try {
    await api('POST', '/api/auth/logout');
  } catch {
    /* déjà déconnecté */
  }
  state.user = null;
  state.csrfToken = null;
  renderAccount();
  toast('Vous êtes déconnecté.');
  route();
}

function renderAccount() {
  if (!state.user) {
    accountBox.replaceChildren(h('button', { class: 'btn btn-ghost', type: 'button', onclick: openLogin }, icon('user'), h('span', {}, 'Connexion')));
    return;
  }
  const u = state.user;
  const avatar = h(
    'button',
    {
      class: 'avatar',
      type: 'button',
      title: u.username,
      'aria-label': `Compte ${u.username}`,
      onclick: (e) => {
        e.stopPropagation();
        openMenu(
          e.currentTarget,
          [
            { label: 'Changer le mot de passe', icon: 'lock', onClick: changePassword },
            { label: 'Se déconnecter', icon: 'close', onClick: logout },
          ],
          h('div', { class: 'menu-header' }, h('strong', {}, u.username), h('span', {}, u.role === 'admin' ? 'Administrateur' : 'Lecteur')),
        );
      },
    },
    u.username.slice(0, 1).toUpperCase(),
  );
  accountBox.replaceChildren(u.role === 'admin' ? h('span', { class: 'badge' }, 'Admin') : '', avatar);
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------

async function init() {
  try {
    const me = await api('GET', '/api/auth/me');
    Object.assign(state, { user: me.user, csrfToken: me.csrfToken, publicRead: me.publicRead, siteTitle: me.siteTitle });
    document.getElementById('site-title').textContent = me.siteTitle;
  } catch {
    toast('Impossible de joindre le serveur.', 'error');
  }
  renderAccount();
  route();
}

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !isViewerOpen() && document.activeElement === document.body) {
    e.preventDefault();
    searchInput.focus();
  }
});

init();
