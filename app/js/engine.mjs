import * as pdfjsLib from '../vendor/pdfjs/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/build/pdf.worker.mjs', import.meta.url).href;

const base = new URL('../vendor/pdfjs/', import.meta.url).href;
const LOAD_OPTS = {
  cMapUrl: base + 'cmaps/',
  cMapPacked: true,
  standardFontDataUrl: base + 'standard_fonts/',
  isEvalSupported: false,
  useSystemFonts: true,
};

export { pdfjsLib };

/** 载入 PDF，返回文档模型（不含 UI 状态） */
export async function loadPdf(bytes, password) {
  // pdf.js 会接管（detach）传入的 buffer，必须给副本
  const data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes);
  const task = pdfjsLib.getDocument({ ...LOAD_OPTS, data, password });
  const pdf = await task.promise;

  const pages = [];
  const pageRefs = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    pages.push({ w: vp.width, h: vp.height, rotate: page.rotate || 0, view: page.view.slice() });
    pageRefs.push(page);
  }

  const meta = await pdf.getMetadata().catch(() => ({ info: {}, metadata: null }));
  const outline = await getOutline(pdf).catch(() => []);
  const attachments = await getAttachmentsSafe(pdf);

  return {
    pdf,
    numPages: pdf.numPages,
    pages,
    meta: meta.info || {},
    xmp: meta.metadata || null,
    outline,
    attachments,
    fingerprints: pdf.fingerprints,
  };
}

function getAttachmentsSafe(pdf) {
  return pdf.getAttachments().then((map) => {
    if (!map) return [];
    return Object.keys(map).map((name) => ({
      name: map[name].filename || name,
      size: map[name].content ? map[name].content.length : 0,
      content: map[name].content,
    }));
  }).catch(() => []);
}

export async function getOutline(pdf) {
  const raw = await pdf.getOutline();
  if (!raw) return [];
  const walk = async (items, depth) => {
    const out = [];
    for (const it of items) {
      let page = 0;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest)) {
          const ref = dest[0];
          if (typeof ref === 'number') page = ref;
          else if (ref && typeof ref === 'object') page = await pdf.getPageIndex(ref);
        } else if (it.url) {
          page = -1;
        }
      } catch { /* 目标可能指向外部或命名目的地 */ }
      out.push({
        title: it.title || '(无标题)',
        page: page + 1,
        url: it.url || null,
        depth,
        children: it.items && it.items.length ? await walk(it.items, depth + 1) : [],
      });
    }
    return out;
  };
  return walk(raw, 0);
}

const textCache = new WeakMap();
export function getTextContent(pdf, pageNum) {
  let map = textCache.get(pdf);
  if (!map) {
    map = new Map();
    textCache.set(pdf, map);
  }
  if (!map.has(pageNum)) {
    const p = pdf.getPage(pageNum).then((page) => page.getTextContent());
    map.set(pageNum, p);
  }
  return map.get(pageNum);
}

const widgetCache = new WeakMap();
export function getWidgets(pdf, pageNum) {
  let map = widgetCache.get(pdf);
  if (!map) {
    map = new Map();
    widgetCache.set(pdf, map);
  }
  if (!map.has(pageNum)) {
    const p = pdf.getPage(pageNum)
      .then((page) => page.getAnnotations({ intent: 'display' }))
      .then((list) => list.filter((a) => a.subtype === 'Widget'))
      .catch(() => []);
    map.set(pageNum, p);
  }
  return map.get(pageNum);
}

export async function getPageViewport(pdf, pageNum, scale, rotation = 0) {
  const page = await pdf.getPage(pageNum);
  const rot = ((page.rotate || 0) + rotation) % 360;
  return page.getViewport({ scale, rotation: rot });
}

/** 渲染一页到 canvas；返回 renderTask 便于取消 */
export function renderPage(pdf, pageNum, canvas, viewport, dpr = window.devicePixelRatio || 1) {
  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
  canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';
  const task = pdf.getPage(pageNum).then((page) => page.render({
    canvasContext: ctx,
    viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    background: '#ffffff',
    annotationMode: 1,
  }));
  return task;
}

export async function renderTextLayer(pdf, pageNum, container, viewport) {
  const textContent = await getTextContent(pdf, pageNum);
  container.replaceChildren();
  container.style.setProperty('--scale-factor', String(viewport.scale));
  const layer = new pdfjsLib.TextLayer({ textContentSource: textContent, container, viewport });
  await layer.render();
  return layer;
}

/** 离屏渲染：给导出/压缩/修订用。返回 canvas */
export async function renderPageOffscreen(pdf, pageNum, scale, rotation = 0) {
  const page = await pdf.getPage(pageNum);
  const vp = page.getViewport({ scale, rotation: ((page.rotate || 0) + rotation) % 360 });
  const canvas = document.createElement('canvas');
  await renderPage(pdf, pageNum, canvas, vp, 1).then((t) => t.promise);
  return canvas;
}
