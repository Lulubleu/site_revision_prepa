// Utilitaires partagés : appels API (avec jeton CSRF) et construction DOM sûre.
// Toutes les données sont insérées via textContent / attributs : jamais d'innerHTML.

export const state = {
  user: null,
  csrfToken: null,
  publicRead: true,
  siteTitle: 'Prépa TSI · Cours',
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, url, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* réponse non JSON */
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || `Erreur ${res.status}`);
  return data;
}

/** Envoi multipart avec progression (fetch ne fournit pas la progression d'upload). */
export function uploadWithProgress(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Accept', 'application/json');
    if (state.csrfToken) xhr.setRequestHeader('X-CSRF-Token', state.csrfToken);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, (data && data.error) || `Erreur ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Connexion interrompue.'));
    xhr.send(formData);
  });
}

/** h('div', { class: 'x', onclick: fn }, 'texte', enfant…) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function icon(name, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function fileKind(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
  return 'file';
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
export const formatDate = (ts) => dateFmt.format(new Date(ts));

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
export const byName = (a, b) => collator.compare(a.name, b.name);

export function plural(n, one, many) {
  return `${n} ${n > 1 ? many : one}`;
}

export function toast(message, type = 'info') {
  const el = h('div', { class: `toast ${type}`, role: 'status' }, icon(type === 'error' ? 'alert' : 'check'), message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3500);
}

/**
 * Boîte de dialogue modale générique (<dialog> natif).
 * fields: [{ name, label, type, value, autocomplete }]
 * onSubmit(values) peut lever une erreur : elle est affichée dans la boîte.
 */
export function openDialog({ title, message, fields = [], submitLabel = 'Valider', danger = false, onSubmit }) {
  return new Promise((resolve) => {
    const errorBox = h('div', { class: 'form-error', role: 'alert', hidden: true });
    const inputs = fields.map((f) =>
      h('input', {
        id: `dlg-${f.name}`,
        name: f.name,
        type: f.type || 'text',
        value: f.value || '',
        autocomplete: f.autocomplete || 'off',
        required: true,
        maxlength: f.maxlength || 200,
      }),
    );
    const submit = h('button', { type: 'submit', class: `btn ${danger ? 'btn-danger' : 'btn-primary'}` }, submitLabel);
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Annuler');
    const form = h(
      'form',
      { method: 'dialog', novalidate: true },
      h('h2', {}, title),
      message ? h('p', {}, message) : null,
      fields.map((f, i) => h('div', { class: 'field' }, h('label', { for: `dlg-${f.name}` }, f.label), inputs[i])),
      errorBox,
      h('div', { class: 'modal-actions' }, cancel, submit),
    );
    const dialog = h('dialog', { class: 'modal' }, form);
    document.body.append(dialog);

    let result = null;
    const close = () => dialog.close();
    cancel.addEventListener('click', close);
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      submit.disabled = true;
      errorBox.hidden = true;
      try {
        result = onSubmit ? await onSubmit(values) : values;
        if (result === undefined) result = true;
        close();
      } catch (err) {
        errorBox.replaceChildren(icon('alert'), err.message);
        errorBox.hidden = false;
        submit.disabled = false;
      }
    });

    dialog.showModal();
    const first = inputs[0];
    if (first) {
      first.focus();
      // Sélectionne le nom sans l'extension (comme Google Drive).
      const dot = first.value.lastIndexOf('.');
      first.setSelectionRange(0, dot > 0 ? dot : first.value.length);
    } else {
      submit.focus();
    }
  });
}

/** Menu contextuel ancré à un bouton. items: [{ label, icon, danger, onClick }] */
export function openMenu(anchor, items, header) {
  closeMenus();
  const menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    header || null,
    items.map((it) =>
      h(
        'button',
        {
          class: `menu-item${it.danger ? ' danger' : ''}`,
          role: 'menuitem',
          type: 'button',
          onclick: (e) => {
            e.stopPropagation();
            closeMenus();
            it.onClick();
          },
        },
        icon(it.icon),
        it.label,
      ),
    ),
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let left = r.right - mw + window.scrollX;
  if (left < 8) left = 8;
  let top = r.bottom + 4 + window.scrollY;
  if (r.bottom + mh + 8 > window.innerHeight) top = r.top - mh - 4 + window.scrollY;
  menu.style.left = `${left}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.querySelector('.menu-item')?.focus();
  setTimeout(() => {
    document.addEventListener('click', closeMenus, { once: true });
  });
  return menu;
}

export function closeMenus() {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
});
