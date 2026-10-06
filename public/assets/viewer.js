// Visionneuse intégrée : PDF via PDF.js (servi en local), images natives,
// et bouton de téléchargement pour les autres types.
import { h, icon, fileKind, formatSize } from './lib.js';

const PDFJS_BASE = '/vendor/pdfjs/legacy/build';
let pdfjsPromise = null;

export function loadPdfJs() {
  pdfjsPromise ||= import(`${PDFJS_BASE}/pdf.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/pdf.worker.mjs`;
    return lib;
  });
  return pdfjsPromise;
}

const root = document.getElementById('viewer-root');
let active = null; // { el, cleanup }

export const isViewerOpen = () => !!active;

export function closeViewer() {
  if (!active) return;
  active.cleanup();
  active.el.remove();
  active = null;
  document.body.style.overflow = '';
}

export function openViewer(file, { onClose }) {
  closeViewer();
  const kind = fileKind(file.name);
  const viewUrl = `/api/files/${file.id}/view`;
  const downloadUrl = `/api/files/${file.id}/download`;

  const body = h('div', { class: 'viewer-body', tabindex: -1 });
  const tools = h('div', { class: 'viewer-tools' });
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Fermer (Échap)', 'aria-label': 'Fermer', onclick: () => onClose() }, icon('close'));
  const el = h(
    'div',
    { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': file.name },
    h(
      'div',
      { class: 'viewer-bar' },
      closeBtn,
      h('div', { class: 'viewer-title' }, icon(kind, `kind-${kind}`), h('span', { class: 'vname', title: file.name }, file.name)),
      tools,
    ),
    body,
  );

  const extraButtons = [
    file.inline
      ? h('a', { class: 'btn viewer-btn hide-sm', href: viewUrl, target: '_blank', rel: 'noopener', title: 'Ouvrir dans le lecteur du navigateur' }, icon('external'), h('span', { class: 'lbl' }, 'Nouvel onglet'))
      : null,
    h('a', { class: 'btn viewer-btn', href: downloadUrl, download: '' }, icon('download'), h('span', { class: 'lbl' }, 'Télécharger')),
  ];

  let disposePdf = () => {};
  const onKey = (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open], .menu')) {
      e.preventDefault();
      onClose();
    }
  };
  document.addEventListener('keydown', onKey);

  active = {
    el,
    cleanup: () => {
      document.removeEventListener('keydown', onKey);
      disposePdf();
    },
  };
  root.append(el);
  document.body.style.overflow = 'hidden';
  closeBtn.focus();

  if (kind === 'pdf') {
    disposePdf = renderPdf(viewUrl, body, tools, extraButtons);
  } else if (kind === 'image' && file.inline) {
    tools.replaceChildren(...extraButtons);
    body.replaceChildren(h('div', { class: 'viewer-center' }, h('img', { src: viewUrl, alt: file.name })));
  } else {
    tools.replaceChildren(...extraButtons);
    body.replaceChildren(
      h(
        'div',
        { class: 'viewer-center' },
        h(
          'div',
          { class: 'viewer-msg' },
          icon('file'),
          h('strong', {}, 'Aperçu indisponible pour ce type de fichier'),
          h('span', {}, `${file.name} · ${formatSize(file.size)}`),
          h('a', { class: 'btn btn-primary', href: downloadUrl, download: '' }, icon('download'), 'Télécharger'),
        ),
      ),
    );
  }
}

/** Rendu PDF.js : pages rendues paresseusement à l'approche de la zone visible. */
function renderPdf(url, body, tools, extraButtons) {
  let disposed = false;
  let pdf = null;
  let loadingTask = null;
  let scale = 1;
  let fitMode = true;
  let baseWidth = 0;
  let pages = []; // { wrap, canvas, rendered, task }
  let observer = null;
  let visibleObserver = null;
  const visible = new Map();

  body.replaceChildren(h('div', { class: 'viewer-center' }, h('div', { class: 'spinner', 'aria-label': 'Chargement du PDF' })));

  const pageInput = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': 'Page', value: '1' });
  const pageTotal = h('span', {}, '/ –');
  const zoomLabel = h('span', { class: 'zoom-label' }, '100 %');
  const btn = (ic, label, onclick, cls = '') => h('button', { class: `icon-btn ${cls}`, type: 'button', title: label, 'aria-label': label, onclick }, icon(ic));

  tools.replaceChildren(
    h('div', { class: 'page-ctl' }, pageInput, pageTotal),
    h('span', { class: 'sep hide-sm' }),
    btn('zoom-out', 'Zoom arrière (−)', () => setZoom(scale / 1.2)),
    zoomLabel,
    btn('zoom-in', 'Zoom avant (+)', () => setZoom(scale * 1.2)),
    btn('fit', 'Ajuster à la largeur', () => fit(), 'hide-sm'),
    h('span', { class: 'sep' }),
    ...extraButtons,
  );

  pageInput.addEventListener('change', () => goTo(Number.parseInt(pageInput.value, 10)));
  pageInput.addEventListener('focus', () => pageInput.select());

  function goTo(n) {
    if (!pdf || !Number.isFinite(n)) return;
    const p = Math.min(Math.max(1, n), pdf.numPages);
    pages[p - 1].wrap.scrollIntoView({ block: 'start' });
    pageInput.value = String(p);
  }

  function fitScale() {
    // Largeur disponible, plafonnée pour garder une ligne de lecture confortable.
    const avail = Math.min(Math.max(200, body.clientWidth - 32), 1000);
    return avail / baseWidth;
  }

  function fit() {
    fitMode = true;
    applyScale(fitScale());
  }

  function setZoom(next) {
    fitMode = false;
    applyScale(Math.min(Math.max(next, 0.25), 5));
  }

  function applyScale(next) {
    // Conserve la position relative de lecture lors du zoom.
    const ratio = body.scrollHeight ? body.scrollTop / body.scrollHeight : 0;
    scale = next;
    zoomLabel.textContent = `${Math.round(scale * 100)} %`;
    layout();
    body.scrollTop = ratio * body.scrollHeight;
  }

  function layout() {
    for (const p of pages) {
      if (p.task) p.task.cancel();
      p.task = null;
      p.rendered = false;
      const w = Math.floor(p.width * scale);
      const hgt = Math.floor(p.height * scale);
      p.wrap.style.width = `${w}px`;
      p.wrap.style.height = `${hgt}px`;
      p.canvas.width = 0;
      p.canvas.height = 0;
    }
    // Force la réévaluation des pages visibles.
    if (observer) {
      observer.disconnect();
      for (const p of pages) observer.observe(p.wrap);
    }
  }

  async function renderPage(p) {
    if (p.rendered || disposed) return;
    p.rendered = true;
    try {
      const page = await pdf.getPage(p.index + 1);
      if (disposed) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport });
      p.task = task;
      await task.promise;
      p.task = null;
      if (disposed) return;
      // Ajuste le cadre si la page diffère de la taille estimée.
      p.width = viewport.width / dpr / scale;
      p.height = viewport.height / dpr / scale;
      p.wrap.style.width = canvas.style.width;
      p.wrap.style.height = canvas.style.height;
      p.canvas.replaceWith(canvas);
      p.canvas = canvas;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      p.rendered = false;
      console.error(err);
    }
  }

  (async () => {
    try {
      const pdfjs = await loadPdfJs();
      if (disposed) return;
      loadingTask = pdfjs.getDocument({
        url,
        withCredentials: true,
        isEvalSupported: false, // compatible avec la CSP (pas de unsafe-eval)
        cMapUrl: '/vendor/pdfjs/cmaps/',
        cMapPacked: true,
        standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      });
      pdf = await loadingTask.promise;
      if (disposed) return;

      const first = await pdf.getPage(1);
      const vp = first.getViewport({ scale: 1 });
      baseWidth = vp.width;
      pageTotal.textContent = `/ ${pdf.numPages}`;

      const container = h('div', { class: 'pdf-pages' });
      pages = Array.from({ length: pdf.numPages }, (_, index) => {
        const canvas = document.createElement('canvas');
        const wrap = h('div', { class: 'pdf-page', dataset: { index } }, canvas, h('span', { class: 'pnum' }, String(index + 1)));
        container.append(wrap);
        return { index, wrap, canvas, width: vp.width, height: vp.height, rendered: false, task: null };
      });
      body.replaceChildren(container);

      // Rendu paresseux : uniquement les pages proches de la zone visible.
      observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) if (e.isIntersecting) renderPage(pages[Number(e.target.dataset.index)]);
        },
        { root: body, rootMargin: '600px 0px' },
      );
      // Numéro de page courante.
      visibleObserver = new IntersectionObserver(
        (entries) => {
          for (const e of entries) visible.set(Number(e.target.dataset.index), e.intersectionRatio);
          let best = 0;
          let bestRatio = -1;
          for (const [i, r] of visible) if (r > bestRatio) [best, bestRatio] = [i, r];
          if (document.activeElement !== pageInput) pageInput.value = String(best + 1);
        },
        { root: body, threshold: [0, 0.25, 0.5, 0.75, 1] },
      );
      for (const p of pages) {
        observer.observe(p.wrap);
        visibleObserver.observe(p.wrap);
      }
      fit();
      body.focus();
    } catch (err) {
      if (disposed) return;
      console.error(err);
      body.replaceChildren(
        h(
          'div',
          { class: 'viewer-center' },
          h(
            'div',
            { class: 'viewer-msg' },
            icon('alert'),
            h('strong', {}, 'Impossible d’afficher ce PDF ici'),
            h('span', {}, 'Vous pouvez l’ouvrir dans le lecteur de votre navigateur ou le télécharger.'),
            h('div', { class: 'modal-actions' }, ...extraButtons.map((b) => b.cloneNode(true))),
          ),
        ),
      );
    }
  })();

  // Raccourcis clavier et ré-ajustement au redimensionnement.
  const onKey = (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === '+' || e.key === '=') setZoom(scale * 1.2);
    else if (e.key === '-') setZoom(scale / 1.2);
    else if (e.key === '0') fit();
  };
  let resizeTimer;
  const onResize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => fitMode && pdf && fit(), 150);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  return () => {
    disposed = true;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onResize);
    observer?.disconnect();
    visibleObserver?.disconnect();
    for (const p of pages) p.task?.cancel();
    if (loadingTask) loadingTask.destroy();
  };
}
