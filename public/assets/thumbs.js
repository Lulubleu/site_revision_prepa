// Miniatures paresseuses : 1re page des PDF (PDF.js) et aperçu des images,
// générées uniquement quand la carte devient visible, 2 à la fois au maximum.
import { loadPdfJs } from './viewer.js';

const queue = [];
let running = 0;
const MAX_CONCURRENT = 2;
const THUMB_WIDTH = 320; // px (≈ 2× la largeur affichée, net sur écrans HiDPI)

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      observer.unobserve(e.target);
      queue.push(e.target);
    }
    pump();
  },
  { rootMargin: '200px' },
);

export function observeThumb(thumbEl, file, kind) {
  if (kind !== 'pdf' && kind !== 'image') return;
  thumbEl._thumb = { file, kind };
  observer.observe(thumbEl);
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const el = queue.shift();
    if (!el.isConnected) continue;
    running++;
    render(el)
      .catch(() => {}) // on garde l'icône générique en cas d'échec
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function render(el) {
  const { file, kind } = el._thumb;
  const url = `/api/files/${file.id}/view`;

  if (kind === 'image') {
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.onload = () => {
        el.append(img);
        resolve();
      };
      img.onerror = reject;
      img.src = url;
    });
    return;
  }

  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    url,
    withCredentials: true,
    isEvalSupported: false,
    disableAutoFetch: true, // ne télécharge que les octets nécessaires à la 1re page
    disableStream: true,
    cMapUrl: '/vendor/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
  });
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    if (el.isConnected) el.append(canvas);
  } finally {
    task.destroy();
  }
}
