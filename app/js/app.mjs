import {
  $, $$, h, uid, clamp, fmtBytes, fmtDate, truncate, escapeHtml, hexToRgb01, rgb01ToHex,
  blobToDataURL, bytesToDataURL, debounce,
} from './util.mjs';
import { icon } from './icons.mjs';
import { loadPdf, getTextContent, renderPageOffscreen, getPageViewport } from './engine.mjs';
import { Viewer } from './viewer.mjs';
import * as ops from './ops.mjs';

const P = window.minipdf;

/* ────────────────────────────────────────────────────────────
   状态
   ──────────────────────────────────────────────────────────── */
const S = {
  docs: [],
  activeId: null,
  color: '#ffe14d',
  tool: 'select',
  theme: localStorage.getItem('minipdf.theme') || 'light',
  sidePanel: 'thumbs',
  sideOpen: true,
  toolsOpen: true,
  organize: false,
  selectedPages: new Set(),
  lastSignature: null,
  assetRatio: 2.6,
  fontSize: 12,
  eraseUnder: true,
  suggestions: [],
  panelTool: null,
  barPinned: false,
};

const PALETTE = ['#ffe14d', '#ff9f1a', '#e8453c', '#2fb344', '#1473e6', '#8e5bd8', '#111111'];

const viewer = new Viewer({
  viewerEl: $('#viewer'),
  pagesEl: $('#pages'),
  onPageChange: (n, total) => {
    $('#pageInput').value = String(n);
    $('#pageTotal').textContent = String(total);
    updateThumbsActive();
    updateStatus();
  },
  onZoom: (scale, mode) => {
    const pct = Math.round(scale * 100) + '%';
    $('#zoomLabel').textContent = pct;
    $('#stZoom').textContent = pct;
  },
  onMarkup: (tool, items) => {
    toPdfAction(() => {
      pushSnapshot();
      const map = { highlight: 'highlight', underline: 'underline', strikeout: 'strikeout' };
      for (const it of items) {
        active.annots.push({
          id: uid(), page: it.page, type: map[tool], rects: it.rects,
          color: tool === 'highlight' ? S.color : S.color, author: '我', ts: Date.now(), inFile: false,
        });
      }
      markDirty();
      viewer.renderAnnotations();
      renderComments();
      toast(`已添加 ${items.length} 处${labelOf(tool)}`);
    });
  },
  onCreateAnnot: (partial) => createAnnot(partial),
  onDeleteAnnot: (id) => deleteAnnot(id),
  onTextEdit: (id, text) => {
    const a = active?.annots.find((x) => x.id === id);
    if (!a) return;
    a.content = text;
    markDirty();
  },
  onAnnotChanged: () => markDirty(),
  onField: (name, val) => {
    active.fields[name] = val;
    markDirty();
  },
  onRedact: (rect, page) => {
    pushSnapshot();
    active.redacts.push({ page, rect, id: uid() });
    markDirty();
    viewer.renderAnnotations();
    openToolPanel('redact');
  },
  getColor: () => S.color,
  getSignature: () => S.lastSignature,
  getImage: () => S.pendingImage,
  getAssetRatio: () => S.assetRatio || 2.6,
  getFontSize: () => S.fontSize || 12,
  getErase: () => S.eraseUnder !== false,
  onEscape: () => setTool('select'),
});

/* ────────────────────────────────────────────────────────────
   基础工具
   ──────────────────────────────────────────────────────────── */
function getActive() { return S.docs.find((d) => d.id === S.activeId) || null; }
Object.defineProperty(globalThis, 'active', { get: getActive, configurable: true });

function labelOf(tool) {
  return ({
    highlight: '高亮', underline: '下划线', strikeout: '删除线', note: '便签', textbox: '文本框',
    ink: '手绘', rect: '矩形', arrow: '箭头', sign: '签名', image: '图片', redact: '修订',
  })[tool] || '注释';
}

function toast(msg, kind = '') {
  const root = $('#toastRoot');
  const t = h('div', { class: 'toast ' + kind, html: icon(kind === 'err' ? 'info' : kind === 'ok' ? 'check' : 'info', 15) + `<span>${escapeHtml(msg)}</span>` });
  root.append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s, transform .25s';
    t.style.opacity = '0';
    t.style.transform = 'translateY(4px)';
    setTimeout(() => t.remove(), 260);
  }, kind === 'err' ? 4200 : 2600);
}

function markDirty() {
  const d = active;
  if (!d) return;
  d.dirty = true;
  renderTabs();
  updateStatus();
}

function pushSnapshot() {
  const d = active;
  if (!d) return;
  d.past.push({
    bytes: d.bytes.slice(),
    annots: JSON.parse(JSON.stringify(d.annots)),
    redacts: JSON.parse(JSON.stringify(d.redacts)),
    fields: { ...d.fields },
    label: '编辑',
  });
  if (d.past.length > 12) d.past.shift();
  d.future.length = 0;
  updateUndoButtons();
}

function updateUndoButtons() {
  const d = active;
  const canUndo = !!(d && d.past.length);
  const canRedo = !!(d && d.future.length);
  $$('[data-act="undo"]').forEach((b) => (b.disabled = !canUndo));
  $$('[data-act="redo"]').forEach((b) => (b.disabled = !canRedo));
}

async function undo() {
  const d = active;
  if (!d || !d.past.length) return;
  const cur = { bytes: d.bytes.slice(), annots: JSON.parse(JSON.stringify(d.annots)), redacts: JSON.parse(JSON.stringify(d.redacts)), fields: { ...d.fields } };
  const snap = d.past.pop();
  d.future.push(cur);
  await applySnapshot(d, snap);
}

async function redo() {
  const d = active;
  if (!d || !d.future.length) return;
  const cur = { bytes: d.bytes.slice(), annots: JSON.parse(JSON.stringify(d.annots)), redacts: JSON.parse(JSON.stringify(d.redacts)), fields: { ...d.fields } };
  const snap = d.future.pop();
  d.past.push(cur);
  await applySnapshot(d, snap);
}

async function applySnapshot(d, snap) {
  d.bytes = snap.bytes;
  d.annots = snap.annots;
  d.redacts = snap.redacts;
  d.fields = snap.fields;
  d.dirty = true;
  await reloadDoc(d, { keepBytes: true });
  updateUndoButtons();
  renderComments();
  toast('已撤销');
}

/* ────────────────────────────────────────────────────────────
   打开 / 关闭 / 保存
   ──────────────────────────────────────────────────────────── */

/** 读取文件里已有的注释，只展示、不重绘（页面已经把它们画进位图了） */
const ANNOT_TYPES = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Text: 'note', Square: 'rect', Ink: 'ink', Line: 'arrow' };
async function loadExistingAnnots(doc) {
  const out = [];
  const max = Math.min(doc.numPages, 400);
  for (let i = 1; i <= max; i++) {
    let list = [];
    try {
      const page = await doc.pdf.getPage(i);
      list = await page.getAnnotations({ intent: 'display' });
    } catch { continue; }
    for (const a of list) {
      const type = ANNOT_TYPES[a.subtype];
      if (!type) continue;
      const r = a.rect || [0, 0, 0, 0];
      const rect = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
      out.push({
        id: 'file-' + i + '-' + out.length,
        page: i,
        type,
        rects: [rect],
        color: pdfColor(a.color),
        content: (a.contentsObj && a.contentsObj.str) || a.contents || '',
        author: (a.titleObj && a.titleObj.str) || a.title || '原文件',
        ts: Date.now(),
        inFile: true,
        removable: false,
      });
    }
  }
  doc.annots = out;
}

function pdfColor(c) {
  if (!Array.isArray(c) && !(c && c.length)) return '#ffe14d';
  const arr = Array.from(c).map((v) => (v <= 1 ? v * 255 : v));
  return '#' + arr.slice(0, 3).map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}

async function openFromBytes(bytes, { path = null, name = '未命名.pdf', activate = true } = {}) {
  try {
    const loaded = await loadPdf(bytes);
    const doc = {
      id: uid(),
      path,
      name,
      bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      pdf: loaded.pdf,
      numPages: loaded.numPages,
      pages: loaded.pages,
      meta: loaded.meta,
      outline: loaded.outline,
      attachments: loaded.attachments,
      annots: [],
      redacts: [],
      fields: {},
      deleted: [],
      past: [],
      future: [],
      dirty: false,
      searchHits: [],
      currentHit: -1,
      ui: { pageIndex: 0, scaleMode: 'fit-width', scale: 1, rotation: 0 },
      loadedAt: Date.now(),
    };
    S.docs.push(doc);
    if (activate) await activateDoc(doc.id);
    else renderTabs();
    // 已有注释异步读，不挡打开速度
    loadExistingAnnots(doc).then(() => {
      if (S.activeId === doc.id && S.sidePanel === 'comments') renderComments();
    });
    return doc;
  } catch (err) {
    let msg;
    try {
      msg = err && err.name ? `${err.name}: ${err.message || ''} ${err.details || ''}` : (typeof err === 'string' ? err : JSON.stringify(err));
    } catch { msg = String(err); }
    if (err && err.name === 'PasswordException') msg = '文档已加密，请在原程序中解除密码后再打开';
    window.__lastOpenError = msg + '\n' + ((err && err.stack) || '');
    console.error('open failed', err && err.message, err && err.name, window.__lastOpenError);
    toast('打开失败：' + msg, 'err');
    return null;
  }
}

async function openDialog() {
  const files = await P.openPdf();
  for (const f of files) {
    await openFromBytes(f.data, { path: f.path, name: f.name, activate: false });
  }
  if (files.length) await activateDoc(S.docs[S.docs.length - 1].id);
  renderRecent();
}

async function openPath(path, name) {
  const r = await P.readFile(path);
  if (r.error) return toast('打开失败：' + r.error, 'err');
  await openFromBytes(r.data, { path: r.path, name: r.name });
}

async function activateDoc(id) {
  S.activeId = id;
  const d = active;
  if (!d) return;
  $('#welcome').classList.add('hidden');
  document.body.classList.remove('no-doc');
  viewer.setDoc(d);
  updateAnnotBar();
  $('#pageTotal').textContent = String(d.numPages);
  renderTabs();
  renderSidebar();
  updateStatus();
  updateUndoButtons();
  S.selectedPages.clear();
  if (S.organize) renderThumbs();
  $('#stSize').textContent = `${d.pages[0] ? Math.round(d.pages[0].w) + '×' + Math.round(d.pages[0].h) + ' pt' : '—'}`;
  if (S.panelTool) openToolPanel(S.panelTool);
}

async function closeDoc(id) {
  const idx = S.docs.findIndex((d) => d.id === id);
  if (idx < 0) return;
  const d = S.docs[idx];
  if (d.dirty) {
    const ok = await modal({
      title: '关闭前保存？',
      iconName: 'save',
      body: h('p', { text: `「${d.name}」有未保存的改动。关闭后这些改动会丢失。` }),
      actions: [
        { label: '取消', value: 'cancel' },
        { label: '不保存', value: 'discard' },
        { label: '保存', value: 'save', primary: true },
      ],
    });
    if (ok === 'cancel' || ok == null) return;
    if (ok === 'save') {
      const done = await saveDoc();
      if (!done) return;
    }
  }
  S.docs.splice(idx, 1);
  if (S.activeId === id) {
    S.activeId = null;
    const next = S.docs[Math.max(0, idx - 1)] || S.docs[0];
    if (next) await activateDoc(next.id);
    else showWelcome();
  } else renderTabs();
}

async function reloadDoc(d, { keepBytes = false } = {}) {
  const loaded = await loadPdf(d.bytes);
  d.pdf = loaded.pdf;
  d.numPages = loaded.numPages;
  d.pages = loaded.pages;
  d.meta = loaded.meta;
  d.outline = loaded.outline;
  d.attachments = loaded.attachments;
  d.searchHits = [];
  d.currentHit = -1;
  d.ui.pageIndex = Math.min(d.ui.pageIndex, d.numPages - 1);
  viewer.setDoc(d, { restore: true });
  renderTabs();
  renderSidebar();
  updateStatus();
}

function showWelcome() {
  $('#welcome').classList.remove('hidden');
  document.body.classList.add('no-doc');
  updateAnnotBar();
  viewer.clear();
  $('#pages').replaceChildren();
  $('#stFile').textContent = '未打开文档';
  $('#stSize').textContent = '—';
  $('#pageInput').value = '-';
  $('#pageTotal').textContent = '-';
  renderRecent();
  renderTabs();
}

async function saveDoc({ as = false } = {}) {
  const d = active;
  if (!d) return false;
  if (!window.PDFLib) {
    toast('PDF 写入库未载入', 'err');
    return false;
  }
  try {
    const pending = d.annots.filter((a) => !a.inFile);
    const removed = d.deleted.slice();
    const bytes = await ops.savePdf(d.bytes, pending, d.fields, { removed });
    let path = d.path;
    if (!path || as) {
      const suggest = d.name.replace(/\.pdf$/i, '') + (as ? ' - 副本' : '') + '.pdf';
      path = await P.savePdfDialog(suggest);
      if (!path) return false;
    }
    const r = await P.writeFile(path, bytes);
    if (!r.ok) throw new Error(r.error);
    d.path = path;
    d.name = path.split(/[\\/]/).pop();
    d.bytes = new Uint8Array(bytes);
    for (const a of d.annots) a.inFile = true;
    d.deleted = [];
    d.dirty = false;
    d.past = [];
    d.future = [];
    updateUndoButtons();
    await reloadDoc(d);
    toast(`已保存 ${d.name}${pending.length ? `（${pending.length} 处注释已写入）` : ''}`, 'ok');
    return true;
  } catch (err) {
    const msg = /encrypted/i.test(String(err)) ? '文档有加密保护，MiniPDF 暂不支持写回加密文件' : (err.message || String(err));
    toast('保存失败：' + msg, 'err');
    return false;
  }
}

/* ────────────────────────────────────────────────────────────
   标签栏
   ──────────────────────────────────────────────────────────── */
function renderTabs() {
  const box = $('#tabs');
  box.replaceChildren();
  for (const d of S.docs) {
    const tab = h('button', {
      class: 'doc-tab' + (d.id === S.activeId ? ' active' : ''),
      dataset: { id: d.id },
      title: d.path || d.name,
      onclick: () => activateDoc(d.id),
    },
      h('span', { class: 'tab-ic', html: icon('mark', 13) }),
      h('span', { class: 'tab-title', text: d.name }),
      d.dirty ? h('span', { class: 'dot' }) : null,
      h('span', {
        class: 'tab-close', html: icon('close', 11),
        onclick: (e) => { e.stopPropagation(); closeDoc(d.id); },
      }),
    );
    box.append(tab);
  }
}

/* ────────────────────────────────────────────────────────────
   欢迎页
   ──────────────────────────────────────────────────────────── */
async function renderRecent() {
  const list = $('#recentList');
  if (!list) return;
  const items = await P.recent();
  list.replaceChildren();
  if (!items.length) {
    list.append(h('div', { class: 'empty', html: icon('clock', 26) + '<div>还没有打开过文件</div>' }));
    return;
  }
  for (const it of items.slice(0, 8)) {
    list.append(h('button', {
      class: 'recent-item' + (it.exists ? '' : ' missing'),
      onclick: () => (it.exists ? openPath(it.path) : toast('文件已不在原位置', 'err')),
      title: it.path,
    },
      h('span', { html: icon('mark', 18) }),
      h('span', { class: 'ri-main' },
        h('span', { class: 'ri-name', text: it.name }),
        h('span', { class: 'ri-path', text: it.path })),
      h('span', { class: 'ri-meta', text: it.exists ? fmtBytes(it.size) : '缺失' }),
    ));
  }
}

function renderHomeTools() {
  const box = $('#homeTools');
  const tools = [
    ['organize', 'pages', '组织页面', '旋转 / 删除 / 提取'],
    ['annotate', 'highlight', '注释', '高亮与批注'],
    ['fill', 'form', '填写和签名', '表单与签名'],
    ['merge', 'merge', '合并文件', '多份合成一份'],
  ];
  box.replaceChildren();
  for (const [key, ic, name, desc] of tools) {
    box.append(h('button', { class: 'tip-card', onclick: () => openToolPanel(key) },
      h('span', { html: icon(ic, 20) }),
      h('b', { text: name }),
      h('span', { class: 'muted', text: desc })));
  }
}

/* ────────────────────────────────────────────────────────────
   侧栏
   ──────────────────────────────────────────────────────────── */
const SIDE_TITLES = { thumbs: '页面', outline: '书签', comments: '注释', attach: '附件', search: '搜索', props: '文档属性' };

function renderSidebar() {
  $('#sideTitle').textContent = SIDE_TITLES[S.sidePanel] || '面板';
  $$('.rail-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === S.sidePanel));
  const body = $('#sideBody');
  body.replaceChildren();
  if (!active) {
    body.append(h('div', { class: 'empty', text: '未打开文档' }));
    return;
  }
  if (S.sidePanel === 'thumbs') renderThumbs();
  else if (S.sidePanel === 'outline') renderOutline();
  else if (S.sidePanel === 'comments') renderComments();
  else if (S.sidePanel === 'attach') renderAttach();
  else if (S.sidePanel === 'search') renderSearchPanel();
  else if (S.sidePanel === 'props') renderProps();
}

function renderThumbs() {
  const d = active;
  const body = $('#sideBody');
  body.replaceChildren();
  if (!d) return;
  if (S.organize) {
    body.append(h('div', { class: 'search-sum', text: `已选 ${S.selectedPages.size} 页 · 可拖拽调整顺序` }));
  }
  const list = h('div', { class: 'thumb-list' });
  d.pages.forEach((p, i) => {
    const cw = 116;
    const ch = Math.max(24, Math.round((p.h / p.w) * cw));
    const holder = h('div', { class: 'thumb-canvas', style: { height: ch + 'px' } });
    const canvas = h('canvas');
    holder.append(canvas);
    const item = h('div', {
      class: 'thumb-item' + (i === (d.ui.pageIndex || 0) ? ' active' : ''),
      dataset: { idx: String(i) },
      draggable: 'true',
      onclick: (e) => {
        if (S.organize || e.ctrlKey || e.metaKey || e.shiftKey) {
          togglePageSelect(i);
        } else viewer.goToPage(i + 1);
      },
    },
      S.organize ? h('input', { type: 'checkbox', checked: S.selectedPages.has(i), onclick: (e) => { e.stopPropagation(); togglePageSelect(i); } }) : null,
      holder,
      h('div', { class: 'tn', text: String(i + 1) }),
    );
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/minipdf-page', String(i));
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => { e.preventDefault(); item.classList.add('drag-over'); });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      const from = Number(e.dataTransfer.getData('text/minipdf-page'));
      if (Number.isNaN(from) || from === i) return;
      await doMovePage(from, i);
    });
    list.append(item);
    setTimeout(() => viewer.renderThumb(i + 1, canvas, cw), 30 + i * 12);
  });
  body.append(list);
}

function togglePageSelect(i) {
  if (S.selectedPages.has(i)) S.selectedPages.delete(i);
  else S.selectedPages.add(i);
  if (S.organize) renderThumbs();
  else viewer.goToPage(i + 1);
}

function updateThumbsActive() {
  const d = active;
  if (!d || S.sidePanel !== 'thumbs') return;
  $$('.thumb-item').forEach((el, i) => el.classList.toggle('active', i === (d.ui.pageIndex || 0)));
}

function renderOutline() {
  const d = active;
  const body = $('#sideBody');
  body.replaceChildren();
  if (!d.outline || !d.outline.length) {
    body.append(h('div', { class: 'empty', html: icon('bookmark', 26) + '<div>这份文档没有书签</div><div class="muted">书签由原文件提供，MiniPDF 不会伪造</div>' }));
    return;
  }
  const tree = h('div', { class: 'tree' });
  const walk = (items, parent, depth) => {
    for (const it of items) {
      const row = h('button', { class: 'tree-row', title: it.title, onclick: () => (it.url ? P.openExternal(it.url) : viewer.goToPage(it.page)) },
        h('span', { class: 'tw', html: it.children.length ? icon('chevronDown', 12) : '' }),
        h('span', { class: 'tt', text: it.title }),
      );
      parent.append(row);
      if (it.children.length) {
        const kids = h('div', { class: 'tree-kids' });
        walk(it.children, kids, depth + 1);
        parent.append(kids);
      }
    }
  };
  walk(d.outline, tree, 0);
  body.append(tree);
}

function renderComments() {
  const d = active;
  if (!d) return;
  if (S.sidePanel !== 'comments') return;
  const body = $('#sideBody');
  body.replaceChildren();
  const list = d.annots.slice().sort((a, b) => a.page - b.page || a.ts - b.ts);
  if (!list.length) {
    body.append(h('div', { class: 'empty', html: icon('comment', 26) + '<div>还没有注释</div><div class="muted">选择文本后点高亮，或用工具面板添加便签</div>' }));
    return;
  }
  const wrap = h('div', { class: 'cmt-list' });
  for (const a of list) {
    wrap.append(h('button', {
      class: 'cmt-item',
      onclick: () => {
        viewer.selectedId = a.id;
        viewer.renderAnnotations();
        const r = a.rects[0];
        viewer.scrollToRect(a.page, r);
      },
      ondblclick: () => deleteAnnot(a.id),
    },
      h('span', { class: 'cmt-swatch', style: { background: a.color } }),
      h('span', { class: 'cmt-body' },
        h('b', { text: `${labelOf(a.type)} · 第 ${a.page} 页${a.inFile ? ' · 文件内' : ''}` }),
        h('span', { text: a.content ? truncate(a.content, 42) : a.type === 'sign' ? '签名' : a.type === 'image' ? '图片' : '（无文字）' }),
        h('em', { text: `${a.author || '我'} · ${fmtDate(a.ts)}` })),
    ));
  }
  body.append(wrap);
  body.append(h('div', { class: 'search-sum', text: `共 ${list.length} 条 · 双击可删除` }));
}

function renderAttach() {
  const d = active;
  const body = $('#sideBody');
  body.replaceChildren();
  if (!d.attachments.length) {
    body.append(h('div', { class: 'empty', html: icon('attach', 26) + '<div>没有附件</div>' }));
    return;
  }
  for (const a of d.attachments) {
    body.append(h('button', { class: 'attach-item', onclick: () => exportAttachment(a) },
      h('span', { html: icon('attach', 18) }),
      h('span', { class: 'ai' }, h('b', { text: a.name }), h('span', { text: fmtBytes(a.size) })),
      h('span', { html: icon('download', 15) }),
    ));
  }
}

async function exportAttachment(a) {
  const path = await P.saveFileDialog({ title: '导出附件', defaultName: a.name });
  if (!path) return;
  const r = await P.writeFile(path, a.content, { addRecent: false });
  if (r.ok) toast('附件已导出：' + a.name, 'ok');
  else toast('导出失败：' + r.error, 'err');
}

function renderSearchPanel() {
  const body = $('#sideBody');
  body.replaceChildren();
  const input = h('input', { placeholder: '输入要查找的文字', value: S.lastQuery || '', spellcheck: 'false' });
  const caseChk = h('input', { type: 'checkbox' });
  const box = h('div', { class: 'search-box' },
    h('div', { class: 'row' }, input, h('button', { class: 'btn small primary', text: '查找', onclick: () => runSearch(input.value, caseChk.checked) })),
    h('div', { class: 'opt' }, h('label', {}, caseChk, '区分大小写'), h('span', { class: 'muted', text: '整篇搜索，结果按页列出' })),
  );
  body.append(box);
  const results = h('div', {});
  body.append(results);
  const d = active;
  if (d && d.searchHits.length) {
    renderHits(results, d);
  } else {
    results.append(h('div', { class: 'empty', html: icon('search', 24) + '<div>输入关键词后回车</div>' }));
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch(input.value, caseChk.checked);
  });
  setTimeout(() => input.focus(), 30);
}

function renderHits(box, d) {
  box.replaceChildren();
  box.append(h('div', { class: 'search-sum', text: `找到 ${d.searchHits.length} 处匹配` }));
  const list = h('div', { class: 'hit-list' });
  d.searchHits.slice(0, 400).forEach((hit, i) => {
    list.append(h('button', {
      class: 'hit-item' + (i === d.currentHit ? ' active' : ''),
      onclick: () => gotoHit(i),
    },
      h('div', { class: 'hp', text: `第 ${hit.page} 页` }),
      h('div', { class: 'hs', text: hit.snippet }),
    ));
  });
  box.append(list);
}

async function runSearch(query, caseSensitive = false) {
  const d = active;
  if (!d) return;
  query = (query || '').trim();
  S.lastQuery = query;
  if (!query) {
    d.searchHits = [];
    d.currentHit = -1;
    viewer.renderSearchHits();
    renderSidebar();
    return;
  }
  const body = $('#sideBody');
  const status = h('div', { class: 'search-sum', text: '正在搜索…' });
  body.append(status);
  d.searchHits = [];
  d.currentHit = -1;
  const needle = caseSensitive ? query : query.toLowerCase();
  for (let p = 1; p <= d.numPages; p++) {
    const tc = await getTextContent(d.pdf, p);
    let text = '';
    const items = [];
    for (const it of tc.items) {
      if (!it.str) continue;
      const start = text.length;
      text += it.str;
      items.push({ start, end: text.length, str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || 10 });
      if (it.hasEOL) text += '\n';
    }
    const hay = caseSensitive ? text : text.toLowerCase();
    let from = 0;
    while (from <= hay.length) {
      const idx = hay.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + needle.length;
      const rects = [];
      for (const item of items) {
        if (item.end <= idx) continue;
        if (item.start >= end) break;
        const s = Math.max(0, idx - item.start);
        const e = Math.min(item.str.length, end - item.start);
        if (e <= s) continue;
        const x1 = item.x + (item.w * s) / item.str.length;
        const x2 = item.x + (item.w * e) / item.str.length;
        rects.push([x1, item.y, x2, item.y + item.h]);
      }
      if (rects.length) {
        d.searchHits.push({
          page: p,
          rects,
          snippet: text.slice(Math.max(0, idx - 26), Math.min(text.length, end + 30)).replace(/\s+/g, ' '),
          index: d.searchHits.length,
        });
      }
      from = end;
      if (d.searchHits.length > 2500) break;
    }
  }
  d.currentHit = d.searchHits.length ? 0 : -1;
  viewer.renderSearchHits();
  renderSidebar();
  if (d.searchHits.length) gotoHit(0);
  else toast('没有找到「' + query + '」', 'err');
}

function gotoHit(i) {
  const d = active;
  if (!d || !d.searchHits.length) return;
  d.currentHit = (i + d.searchHits.length) % d.searchHits.length;
  const hit = d.searchHits[d.currentHit];
  viewer.renderSearchHits();
  viewer.scrollToRect(hit.page, hit.rects[0]);
  renderSidebar();
  $('#pageChip').classList.remove('hidden');
  $('#pageChip').textContent = `第 ${hit.page} 页 · 第 ${d.currentHit + 1} / ${d.searchHits.length} 处`;
  clearTimeout(S._chipT);
  S._chipT = setTimeout(() => $('#pageChip').classList.add('hidden'), 1600);
}

function renderProps() {
  const d = active;
  const body = $('#sideBody');
  body.replaceChildren();
  if (!d) return;
  const info = d.meta || {};
  const rows = [
    ['文件名', d.name],
    ['页数', String(d.numPages)],
    ['页面尺寸', d.pages[0] ? `${Math.round(d.pages[0].w)} × ${Math.round(d.pages[0].h)} pt` : '—'],
    ['文件大小', fmtBytes(d.bytes.length)],
    ['标题', info.Title || '—'],
    ['作者', info.Author || '—'],
    ['主题', info.Subject || '—'],
    ['关键词', info.Keywords || '—'],
    ['创建工具', info.Creator || '—'],
    ['生成工具', info.Producer || '—'],
    ['创建时间', info.CreationDate ? formatPdfDate(info.CreationDate) : '—'],
    ['修改时间', info.ModDate ? formatPdfDate(info.ModDate) : '—'],
    ['文件路径', d.path || '（尚未保存到磁盘）'],
    ['注释', `${d.annots.length} 条（本次会话）`],
  ];
  const wrap = h('div', { class: 'props' });
  wrap.append(h('h3', { text: '文档' }));
  for (const [k, v] of rows) {
    wrap.append(h('div', { class: 'prop-row' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v || '—' })));
  }
  body.append(wrap);
}

function formatPdfDate(s) {
  const m = /D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(String(s));
  if (!m) return String(s);
  return `${m[1]}-${m[2]}-${m[3]} ${m[4] || '00'}:${m[5] || '00'}`;
}

/* ────────────────────────────────────────────────────────────
   注释模型
   ──────────────────────────────────────────────────────────── */
function toPdfAction(fn) {
  try { fn(); } catch (e) { console.error(e); toast('操作失败：' + e.message, 'err'); }
}

function createAnnot(partial) {
  const d = active;
  if (!d) return;
  pushSnapshot();
  const a = {
    id: uid(), author: '我', ts: Date.now(), inFile: false,
    ...partial,
  };
  if (a.type === 'freetext') a.type = 'textbox';
  d.annots.push(a);
  markDirty();
  viewer.renderAnnotations();
  renderComments();
  if (a.type === 'textbox') {
    setTimeout(() => {
      const el = document.querySelector(`.annot[data-id="${a.id}"]`);
      if (el) {
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }, 60);
  }
  if (a.type === 'note' && !S.silentNote && !a.content) {
    promptNote(a);
  }
  return a;
}

async function promptNote(a) {
  const val = await modal({
    title: '便签内容',
    iconName: 'note',
    body: h('div', { class: 'field' }, h('textarea', { placeholder: '写点什么…', id: 'noteText' }), h('span', { class: 'hint', text: '保存后作为 PDF 注释写入文件，其他阅读器也能看到' })),
    actions: [{ label: '取消', value: null }, { label: '添加', value: 'ok', primary: true }],
    onMount: (m) => setTimeout(() => m.querySelector('#noteText')?.focus(), 40),
    collect: (m) => m.querySelector('#noteText').value,
  });
  if (val == null) {
    // 取消：撤掉刚建的便签
    deleteAnnot(a.id, { silent: true });
    return;
  }
  a.content = val;
  markDirty();
  renderComments();
  viewer.renderAnnotations();
}

async function deleteAnnot(id, { silent = false } = {}) {
  const d = active;
  if (!d) return;
  const idx = d.annots.findIndex((a) => a.id === id);
  if (idx < 0) return;
  const a = d.annots[idx];
  if (a.inFile && a.removable === false) {
    toast('这条注释由其他程序写入，MiniPDF 暂不支持删除', 'err');
    return;
  }
  pushSnapshot();
  d.annots.splice(idx, 1);
  if (viewer.selectedId === id) viewer.selectedId = null;
  markDirty();
  if (a.inFile) {
    // 已经写进文件的注释：从字节里真正摘掉，再重绘，避免"列表删了页面还在"
    try {
      const bytes = await ops.savePdf(d.bytes, [], {}, { removed: [{ page: a.page, nm: a.id }] });
      d.bytes = new Uint8Array(bytes);
      await reloadDoc(d);
    } catch (err) {
      toast('删除已写入的注释失败：' + err.message, 'err');
      return;
    }
  }
  viewer.renderAnnotations();
  renderComments();
  if (!silent) toast('已删除注释');
}

/* ────────────────────────────────────────────────────────────
   工具栏 / 工具面板
   ──────────────────────────────────────────────────────────── */
function setTool(tool) {
  S.tool = tool;
  viewer.setTool(tool);
  $$('#toolModes .tb-icon').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  $$('#annotBar button[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  updateAnnotBar();
  openToolPanel(S.panelTool);
}

/** 改字号：只作用在选中的文本框上，顺手重算高度 */
function applyFontSize() {
  const d = active;
  if (!d) return;
  const a = d.annots.find((x) => x.id === viewer.selectedId && x.type === 'textbox');
  if (!a) return;
  a.fontSize = S.fontSize;
  markDirty();
  viewer.renderAnnotations();
  setTimeout(() => viewer.syncTextboxHeights(), 40);
}

function updateAnnotBar() {  const bar = $('#annotBar');
  const show = !!active && (S.barPinned || S.tool !== 'select');
  bar.classList.toggle('hidden', !show);
}

function renderAnnotBar() {
  const bar = $('#annotBar');
  const tools = [
    ['annotate', 'highlight', '高亮'],
    ['annotate', 'underline', '下划线'],
    ['annotate', 'strikeout', '删除线'],
    ['annotate', 'note', '便签'],
    ['annotate', 'textbox', '文本框'],
    ['annotate', 'ink', '手绘'],
    ['annotate', 'rect', '矩形'],
    ['annotate', 'arrow', '箭头'],
    ['annotate', 'sign', '签名'],
  ];
  bar.replaceChildren();
  bar.append(h('span', { class: 'bar-label', text: '注释' }));
  for (const [, t, name] of tools) {
    bar.append(h('button', { dataset: { tool: t }, title: name, html: icon(t === 'textbox' ? 'text' : t, 17), onclick: () => handleToolButton(t) }));
  }
  bar.append(h('span', { class: 'bar-sep' }));
  bar.append(h('button', { dataset: { tool: 'select' }, title: '选择', html: icon('cursor', 17), onclick: () => setTool('select') }));
  updateAnnotBar();
}

async function handleToolButton(tool) {
  if (tool === 'sign' && !S.lastSignature) {
    const sig = await pickSignature();
    if (!sig) return;
  }
  if (tool === 'image') {
    const img = await pickImage();
    if (!img) return;
    S.pendingImage = img;
  }
  setTool(tool);
  openToolPanel(tool === 'sign' ? 'fill' : 'annotate');
}

const TOOL_LIST = [
  ['organize', 'pages', '组织页面', '旋转、删除、移动、提取'],
  ['merge', 'merge', '合并文件', '多份 PDF 合成一份'],
  ['annotate', 'highlight', '注释', '高亮、便签、手绘、图形'],
  ['fill', 'form', '填写和签名', '表单填写与手写签名'],
  ['edit', 'text', '编辑', '添加文字、图片与签名'],
  ['export', 'download', '导出', '图片或纯文本'],
  ['compress', 'compress', '优化 PDF', '重采样降低体积'],
  ['redact', 'redact', '修订', '真正抹掉内容（栅格化）'],
  ['insert', 'extract', '插入 / 提取', '从别的 PDF 拼页'],
  ['split', 'split', '拆分', '按固定页数拆成多份'],
  ['props', 'info', '文档属性', '元数据与页尺寸'],
  ['protect', 'lock', '保护', '加密（未实现）'],
];

function renderToolsGrid() {
  const grid = $('#toolsGrid');
  grid.replaceChildren();
  const wrap = h('div', { class: 'tool-grid' });
  for (const [key, ic, name, desc] of TOOL_LIST) {
    const soon = key === 'protect';
    wrap.append(h('button', {
      class: 'tool-card' + (soon ? ' soon' : ''),
      onclick: () => (soon ? toast('加密写回需要专用加密库，当前版本未实现', 'err') : openToolPanel(key)),
    },
      h('span', { html: icon(ic, 21) }),
      h('b', { text: name }),
      h('span', { text: desc }),
    ));
  }
  grid.append(wrap);
  grid.append(h('div', { class: 'tools-foot', style: { padding: '14px 2px 0', fontSize: '11px' } },
    h('div', { class: 'muted', text: '所有工具都在本机运行，不上传文件。' })));
}

function openToolPanel(key) {
  if (!S.toolsOpen) {
    S.toolsOpen = true;
    $('#toolsPanel').classList.remove('collapsed');
  }
  S.panelTool = key;
  const grid = $('#toolsGrid');
  grid.replaceChildren();
  if (!key) {
    renderToolsGrid();
    return;
  }
  const meta = TOOL_LIST.find((t) => t[0] === key) || ['', 'wrench', key, ''];
  const head = h('div', { class: 'tphead' },
    h('button', { class: 'mini-btn', html: icon('chevronLeft', 15), onclick: () => openToolPanel(null), title: '返回所有工具' }),
    h('span', { html: icon(meta[1], 17) }),
    h('b', { text: meta[2] }),
  );
  const body = h('div', { class: 'tpbody' });
  grid.append(head, body);
  const d = active;

  if (key === 'annotate') {
    body.append(h('p', { text: '选一种注释工具，然后在页面上操作。选中文本后点高亮会自动吸附到文字行。' }));
    const chips = h('div', { class: 'chips' });
    for (const [t, name] of [['highlight', '高亮'], ['underline', '下划线'], ['strikeout', '删除线'], ['note', '便签'], ['textbox', '文本框'], ['ink', '手绘'], ['rect', '矩形'], ['arrow', '箭头'], ['select', '选择']]) {
      chips.append(h('button', { class: 'chip' + (S.tool === t ? ' active' : ''), text: name, onclick: () => setTool(t) }));
    }
    body.append(chips);
    body.append(h('div', { class: 'hr' }));
    body.append(h('div', { class: 'field' }, h('span', { text: '颜色' }), colorSwatches()));
    body.append(h('p', { class: 'muted', text: '提示：高亮 / 下划线 / 删除线 会写成标准 PDF 注释；文本框与签名会栅格化后写入页面内容，保证中文与打印效果一致。' }));
  } else if (key === 'organize') {
    body.append(h('p', { text: '在左侧缩略图里勾选页面，或用 Ctrl / Shift 多选，然后执行操作。也可以拖动缩略图直接改顺序。' }));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small', text: '全选', onclick: () => { d && d.pages.forEach((_, i) => S.selectedPages.add(i)); S.organize = true; renderThumbs(); } }),
      h('button', { class: 'btn small', text: '清空', onclick: () => { S.selectedPages.clear(); renderThumbs(); } }),
      h('span', { class: 'muted', text: `${S.selectedPages.size} 页` }),
    ));
    body.append(h('div', { class: 'hr' }));
    const rot = h('div', { class: 'row' },
      h('button', { class: 'btn small', text: '↺ 左转 90°', onclick: () => rotateSelected(-90) }),
      h('button', { class: 'btn small', text: '↻ 右转 90°', onclick: () => rotateSelected(90) }),
    );
    body.append(rot);
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small', text: '旋转当前页', onclick: () => rotateSelected(90, true) }),
      h('button', { class: 'btn small', text: '删除当前页', onclick: () => deleteSelected(true) }),
    ));
    body.append(h('div', { class: 'hr' }));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small', text: '提取所选为新文件', onclick: extractSelected }),
      h('button', { class: 'btn small', text: '插入 PDF…', onclick: insertPdf }),
    ));
    body.append(h('p', { class: 'muted', text: '这些操作会直接重写 PDF 页面树，可用 Ctrl+Z 撤销（会话内保留 12 步）。' }));
  } else if (key === 'fill') {
    body.append(h('p', { text: '表单字段会以蓝色输入框覆盖显示，改完保存即可写回原字段。签名支持手写与图片。' }));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small primary', text: '手写签名…', onclick: async () => { const s = await pickSignature(); if (s) { setTool('sign'); toast('在页面上点一下放置签名'); } } }),
      h('button', { class: 'btn small', text: '放置图片…', onclick: async () => { const im = await pickImage(); if (im) { S.pendingImage = im; setTool('image'); toast('在页面上点一下放置图片'); } } }),
    ));
    body.append(h('p', { class: 'muted', text: '选好签名或图片后，在页面上点一下放置；可在选择工具下拖动位置，Delete 删除。' }));
    body.append(h('div', { class: 'hr' }));
    body.append(h('div', { class: 'kv' }, h('span', { text: '本次已填写字段' }), h('b', { text: String(d ? Object.keys(d.fields).length : 0) })));
  } else if (key === 'export') {
    body.append(h('p', { text: '把当前文档导出为图片或纯文本。图片按 150 DPI 渲染，逐页保存到一个文件夹。' }));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small', text: '导出 PNG 图片…', onclick: exportImages }),
      h('button', { class: 'btn small', text: '导出纯文本…', onclick: exportText }),
    ));
    body.append(h('div', { class: 'hr' }));
    body.append(h('button', { class: 'btn small', text: '导出页面为单个 PDF…', onclick: extractSelected }));
  } else if (key === 'compress') {
    const dpi = h('input', { type: 'number', value: '110', min: '60', max: '300', style: { width: '80px' } });
    const q = h('select', {}, h('option', { value: '0.5', text: '低（更小）' }), h('option', { value: '0.68', text: '中', selected: true }), h('option', { value: '0.82', text: '高' }));
    body.append(h('p', { text: '把每页重新采样为 JPEG 再组装成新 PDF。适合扫描件与图片型文档；文字型文档会失去可选中文本。' }));
    body.append(h('div', { class: 'row' }, h('label', { class: 'fld' }, '分辨率 DPI', dpi), h('label', { class: 'fld' }, '画质', q)));
    body.append(h('button', { class: 'btn primary', text: '压缩并另存为…', onclick: () => compressPdf(Number(dpi.value), Number(q.value)) }));
  } else if (key === 'redact') {
    body.append(h('p', { text: '先用「修订」工具框选要抹掉的内容，再应用。应用时受影响页会被栅格化，框内像素变黑，底层文字与矢量一并消失。' }));
    body.append(h('div', { class: 'kv' }, h('span', { text: '待修订区域' }), h('b', { text: String(d ? d.redacts.length : 0) })));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small', text: '框选工具', onclick: () => setTool('redact') }),
      h('button', { class: 'btn small', text: '清除全部', onclick: () => { if (!d) return; d.redacts = []; viewer.renderAnnotations(); openToolPanel('redact'); } }),
    ));
    body.append(h('button', { class: 'btn danger', text: '应用修订并另存为…', onclick: applyRedaction }));
    body.append(h('p', { class: 'muted', text: '注意：栅格化不可逆，建议先另存副本。' }));
  } else if (key === 'merge') {
    body.append(h('p', { text: '选择多份 PDF，按选择顺序追加到当前文档末尾，然后另存为新文件。' }));
    body.append(h('button', { class: 'btn primary', text: '选择要合并的 PDF…', onclick: mergePdfs }));
  } else if (key === 'insert') {
    body.append(h('p', { text: '把另一份 PDF 的全部页面插入到当前页之后，或提取当前所选页面为新文件。' }));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small', text: '插入 PDF…', onclick: insertPdf }),
      h('button', { class: 'btn small', text: '提取所选…', onclick: extractSelected }),
    ));
  } else if (key === 'split') {
    const n = h('input', { type: 'number', value: '1', min: '1', max: '200', style: { width: '80px' } });
    body.append(h('p', { text: '按固定页数把文档拆成多份，保存到指定文件夹。' }));
    body.append(h('label', { class: 'fld' }, '每份页数', n));
    body.append(h('button', { class: 'btn primary', text: '拆分并保存…', onclick: () => splitPdf(Number(n.value)) }));
  } else if (key === 'edit') {
    body.append(h('p', { text: 'PDF 没有「重排文本」的概念，这里的编辑是覆盖式添加：文字以位图写进页面，中文不乱码、打印位置一致，但不会删掉底下的原文。' }));
    const chips = h('div', { class: 'chips' });
    for (const s of [10, 12, 14, 18, 24]) {
      chips.append(h('button', {
        class: 'chip' + (S.fontSize === s ? ' active' : ''), text: s + 'pt',
        onclick: () => { S.fontSize = s; applyFontSize(); openToolPanel('edit'); },
      }));
    }
    body.append(h('label', { class: 'fld' }, '字号', chips));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small primary', text: '添加文本', onclick: () => { setTool('textbox'); toast('在页面上点一下，直接打字'); } }),
      h('button', { class: 'btn small', text: '添加图片', onclick: async () => { const im = await pickImage(); if (im) { S.pendingImage = im; setTool('image'); toast('在页面上点一下放置图片'); } } }),
    ));
    body.append(h('div', { class: 'row' },
      h('button', { class: 'btn small', text: '手写签名', onclick: async () => { const s = await pickSignature(); if (s) { setTool('sign'); toast('在页面上点一下放置签名'); } } }),
    ));
    const tbSel = d ? d.annots.find((x) => x.id === viewer.selectedId && x.type === 'textbox') : null;
    if (tbSel) {
      const wInput = h('input', {
        type: 'number', min: '60', max: '560', step: '10',
        value: String(Math.round(tbSel.rects[0][2] - tbSel.rects[0][0])),
        style: { width: '86px' },
      });
      wInput.addEventListener('change', () => {
        const v = clamp(Number(wInput.value) || 190, 60, 560);
        tbSel.rects[0][2] = Math.min(tbSel.rects[0][0] + v, (d.pages[tbSel.page - 1]?.w || 595) - 4);
        markDirty();
        viewer.renderAnnotations();
        setTimeout(() => viewer.syncTextboxHeights(), 40);
      });
      body.append(h('label', { class: 'fld' }, '选中文本框的宽度（pt）', wInput));
    }
    body.append(h('div', { class: 'hr' }));
    const erase = h('input', { type: 'checkbox' });
    erase.checked = S.eraseUnder !== false;
    erase.addEventListener('change', () => {
      S.eraseUnder = erase.checked;
      const a = active?.annots.find((x) => x.id === viewer.selectedId && x.type === 'textbox');
      if (a) { a.erase = erase.checked; markDirty(); viewer.renderAnnotations(); }
      toast(erase.checked ? '文本框会盖住底下的原文（白底）' : '文本框透明，底下的原文会透出来');
    });
    body.append(h('label', { class: 'fld row', style: { alignItems: 'center', gap: '8px', flexDirection: 'row' } },
      erase, h('span', { text: '盖住底下的原文（白底）' })));
    body.append(h('p', { class: 'muted', style: { fontSize: '11.5px' }, text: '选择工具下：点文字框可直接改字，拖动可挪位置，方向键微调，Delete 删除。保存后文字变成页面内容，不再能改。' }));
  } else if (key === 'props') {
    if (!d) { body.append(h('p', { text: '未打开文档' })); return; }
    const title = h('input', { type: 'text', value: d.meta.Title || '' });
    const author = h('input', { type: 'text', value: d.meta.Author || '' });
    const subject = h('input', { type: 'text', value: d.meta.Subject || '' });
    const keywords = h('input', { type: 'text', value: d.meta.Keywords || '' });
    body.append(h('label', { class: 'fld' }, '标题', title), h('label', { class: 'fld' }, '作者', author), h('label', { class: 'fld' }, '主题', subject), h('label', { class: 'fld' }, '关键词（逗号分隔）', keywords));
    body.append(h('button', { class: 'btn primary', text: '写入元数据', onclick: async () => {
      try {
        pushSnapshot();
        d.bytes = await ops.setMetadata(d.bytes, { title: title.value, author: author.value, subject: subject.value, keywords: keywords.value });
        d.dirty = true;
        await reloadDoc(d);
        toast('元数据已写入', 'ok');
      } catch (e) { toast('写入失败：' + e.message, 'err'); }
    } }));
    body.append(h('div', { class: 'hr' }));
    body.append(h('div', { class: 'kv' }, h('span', { text: '页数' }), h('b', { text: String(d.numPages) })),
      h('div', { class: 'kv' }, h('span', { text: '文件大小' }), h('b', { text: fmtBytes(d.bytes.length) })));
  } else if (key === 'protect') {
    body.append(h('p', { text: 'Acrobat 的「保护」使用 RC4 / AES 加密内容流。pdf-lib 不提供加密写入，因此本版本没有实现，也不做假的「密码壳」。' }));
    body.append(h('p', { class: 'muted', text: '如果要发给别人前加密，可以先用系统自带或其他工具加密码，再用 MiniPDF 阅读。' }));
  } else {
    body.append(h('p', { text: '这个工具还没有接线。' }));
  }
}

function colorSwatches() {
  const wrap = h('div', { class: 'swatches' });
  for (const c of PALETTE) {
    wrap.append(h('button', {
      class: 'sw' + (S.color === c ? ' active' : ''),
      style: { background: c },
      title: c,
      onclick: () => { S.color = c; openToolPanel(S.panelTool); },
    }));
  }
  return wrap;
}

/* ────────────────────────────────────────────────────────────
   页面操作
   ──────────────────────────────────────────────────────────── */
async function doMovePage(from, to) {
  const d = active;
  if (!d) return;
  try {
    pushSnapshot();
    const bytes = await ops.movePage(d.bytes, from, to);
    if (!bytes) return;
    d.bytes = bytes;
    d.dirty = true;
    remapAnnots(d, (p) => {
      if (p - 1 === from) return to + 1;
      if (from < to && p - 1 > from && p - 1 <= to) return p - 1;
      if (from > to && p - 1 >= to && p - 1 < from) return p + 1;
      return p;
    });
    await reloadDoc(d);
    toast(`第 ${from + 1} 页移动到第 ${to + 1} 页`, 'ok');
  } catch (e) { toast('移动失败：' + e.message, 'err'); }
}

function remapAnnots(d, fn) {
  for (const a of d.annots) a.page = fn(a.page);
  for (const r of d.redacts) r.page = fn(r.page);
}

async function rotateSelected(delta, currentOnly = false) {
  const d = active;
  if (!d) return;
  const idx = currentOnly || !S.selectedPages.size ? [viewer.currentIndex()] : [...S.selectedPages];
  try {
    pushSnapshot();
    d.bytes = await ops.rotatePages(d.bytes, idx, delta);
    d.dirty = true;
    await reloadDoc(d);
    viewer.goToPage(idx[0] + 1, { instant: true });
    toast(`已旋转 ${idx.length} 页`, 'ok');
  } catch (e) { toast('旋转失败：' + e.message, 'err'); }
}

async function deleteSelected(currentOnly = false) {
  const d = active;
  if (!d) return;
  const idx = currentOnly || !S.selectedPages.size ? [viewer.currentIndex()] : [...S.selectedPages];
  if (idx.length >= d.numPages) return toast('不能删除全部页面', 'err');
  const ok = await modal({
    title: '删除页面',
    iconName: 'trash',
    body: h('p', { text: `将删除第 ${idx.map((i) => i + 1).join('、')} 页（共 ${idx.length} 页）。此操作会重写文件，可用 Ctrl+Z 撤销。` }),
    actions: [{ label: '取消', value: null }, { label: '删除', value: 'ok', primary: true }],
  });
  if (!ok) return;
  try {
    pushSnapshot();
    d.bytes = await ops.deletePages(d.bytes, idx);
    d.dirty = true;
    const set = new Set(idx.map((i) => i + 1));
    d.annots = d.annots.filter((a) => !set.has(a.page));
    d.redacts = d.redacts.filter((r) => !set.has(r.page));
    remapAnnots(d, (p) => p - idx.filter((i) => i + 1 < p).length);
    S.selectedPages.clear();
    await reloadDoc(d);
    toast(`已删除 ${idx.length} 页`, 'ok');
  } catch (e) { toast('删除失败：' + e.message, 'err'); }
}

async function extractSelected() {
  const d = active;
  if (!d) return;
  const idx = S.selectedPages.size ? [...S.selectedPages] : [viewer.currentIndex()];
  try {
    const bytes = await ops.extractPages(d.bytes, idx);
    const path = await P.savePdfDialog(`${d.name.replace(/\.pdf$/i, '')} - 提取.pdf`);
    if (!path) return;
    const r = await P.writeFile(path, bytes);
    if (!r.ok) throw new Error(r.error);
    toast(`已提取 ${idx.length} 页到 ${path.split(/[\\/]/).pop()}`, 'ok');
    await openPath(path);
  } catch (e) { toast('提取失败：' + e.message, 'err'); }
}

async function insertPdf() {
  const d = active;
  if (!d) return;
  const files = await P.openPdf({ title: '选择要插入的 PDF' });
  if (!files.length) return;
  try {
    pushSnapshot();
    const at = viewer.currentIndex() + 1;
    const before = d.numPages;
    d.bytes = await ops.insertPages(d.bytes, files[0].data, null, at);
    d.dirty = true;
    const added = (await ops.pageSizes(files[0].data)).length;
    remapAnnots(d, (p) => (p > at ? p + added : p));
    await reloadDoc(d);
    toast(`已插入 ${d.numPages - before} 页`, 'ok');
  } catch (e) { toast('插入失败：' + e.message, 'err'); }
}

async function mergePdfs() {
  const d = active;
  if (!d) return;
  const files = await P.openPdf({ title: '选择要合并的 PDF（可多选）' });
  if (!files.length) return;
  try {
    pushSnapshot();
    let bytes = d.bytes;
    for (const f of files) bytes = await ops.insertPages(bytes, f.data, null, 999999);
    d.bytes = bytes;
    d.dirty = true;
    await reloadDoc(d);
    toast(`已合并 ${files.length} 份文件，共 ${d.numPages} 页`, 'ok');
  } catch (e) { toast('合并失败：' + e.message, 'err'); }
}

async function splitPdf(chunk) {
  const d = active;
  if (!d || !chunk) return;
  try {
    const parts = await ops.splitEvery(d.bytes, chunk);
    const dir = await P.chooseDir('选择拆分后的保存文件夹');
    if (!dir) return;
    const base = d.name.replace(/\.pdf$/i, '');
    for (const p of parts) {
      await P.writeFile(`${dir}/${base}_${p.from}-${p.to}.pdf`, p.bytes);
    }
    toast(`已拆成 ${parts.length} 份，保存在 ${dir}`, 'ok');
  } catch (e) { toast('拆分失败：' + e.message, 'err'); }
}

async function compressPdf(dpi, quality) {
  const d = active;
  if (!d) return;
  const before = d.bytes.length;
  toast('正在重新采样…');
  try {
    const bytes = await ops.rasterize(d.bytes, async (n, scale) => renderPageOffscreen(d.pdf, n, scale), { dpi, quality, affected: null });
    const path = await P.savePdfDialog(d.name.replace(/\.pdf$/i, '') + ' - 压缩.pdf');
    if (!path) return;
    const r = await P.writeFile(path, bytes);
    if (!r.ok) throw new Error(r.error);
    const ratio = Math.round((1 - bytes.length / before) * 100);
    toast(`已压缩：${fmtBytes(before)} → ${fmtBytes(bytes.length)}（省 ${ratio}%）`, 'ok');
    await openPath(path);
  } catch (e) { toast('压缩失败：' + e.message, 'err'); }
}

async function applyRedaction() {
  const d = active;
  if (!d) return;
  if (!d.redacts.length) return toast('先用修订工具框选内容', 'err');
  try {
    const affected = new Set(d.redacts.map((r) => r.page - 1));
    const bytes = await ops.rasterize(d.bytes, async (n, scale) => renderPageOffscreen(d.pdf, n, scale), {
      dpi: 150, quality: 0.86, affected, redacts: d.redacts,
    });
    const path = await P.savePdfDialog(d.name.replace(/\.pdf$/i, '') + ' - 已修订.pdf');
    if (!path) return;
    const r = await P.writeFile(path, bytes);
    if (!r.ok) throw new Error(r.error);
    toast(`已应用修订（${affected.size} 页栅格化），另存为 ${path.split(/[\\/]/).pop()}`, 'ok');
    await openPath(path);
  } catch (e) { toast('修订失败：' + e.message, 'err'); }
}

async function exportImages() {
  const d = active;
  if (!d) return;
  const dir = await P.chooseDir('选择导出图片的文件夹');
  if (!dir) return;
  const base = d.name.replace(/\.pdf$/i, '');
  toast(`正在导出 ${d.numPages} 页…`);
  try {
    for (let i = 1; i <= d.numPages; i++) {
      const canvas = await renderPageOffscreen(d.pdf, i, 150 / 72);
      const dataUrl = canvas.toDataURL('image/png');
      const b64 = dataUrl.split(',')[1];
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      await P.writeFile(`${dir}/${base}_${String(i).padStart(3, '0')}.png`, arr, { addRecent: false });
    }
    toast(`已导出 ${d.numPages} 张 PNG`, 'ok');
  } catch (e) { toast('导出失败：' + e.message, 'err'); }
}

async function exportText() {
  const d = active;
  if (!d) return;
  try {
    const parts = [];
    for (let i = 1; i <= d.numPages; i++) {
      const tc = await getTextContent(d.pdf, i);
      const text = tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
      parts.push(`===== 第 ${i} 页 =====\n${text.trim()}`);
    }
    const path = await P.saveFileDialog({ title: '导出文本', defaultName: d.name.replace(/\.pdf$/i, '') + '.txt', filters: [{ name: '文本文件', extensions: ['txt'] }] });
    if (!path) return;
    const bytes = new TextEncoder().encode(parts.join('\n\n'));
    const r = await P.writeFile(path, bytes, { addRecent: false });
    if (!r.ok) throw new Error(r.error);
    toast('文本已导出', 'ok');
  } catch (e) { toast('导出失败：' + e.message, 'err'); }
}

async function printDoc() {
  const d = active;
  if (!d) return;
  toast('正在准备打印…');
  try {
    const pages = [];
    for (let i = 1; i <= d.numPages; i++) {
      const canvas = await renderPageOffscreen(d.pdf, i, 150 / 72);
      const info = d.pages[i - 1];
      const rot = ((info.rotate || 0) % 180) === 90;
      pages.push({
        dataUrl: canvas.toDataURL('image/png'),
        wPt: rot ? info.h : info.w,
        hPt: rot ? info.w : info.h,
      });
    }
    const r = await P.printPages(pages);
    if (!r.ok && r.reason) toast('打印取消：' + r.reason, 'err');
  } catch (e) { toast('打印失败：' + e.message, 'err'); }
}

/* ────────────────────────────────────────────────────────────
   模态框
   ──────────────────────────────────────────────────────────── */
function modal({ title, iconName = 'info', body, actions = [], wide = false, onMount, collect }) {
  return new Promise((resolve) => {
    const mask = h('div', { class: 'modal-mask' });
    const box = h('div', { class: 'modal' + (wide ? ' wide' : '') });
    const close = (val) => {
      mask.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
        const primary = actions.find((a) => a.primary);
        if (primary) close(collect ? collect(box) : primary.value);
      }
    };
    box.append(
      h('div', { class: 'modal-head' }, h('span', { html: icon(iconName, 18) }), h('h3', { text: title })),
      h('div', { class: 'modal-body' }, body),
    );
    if (actions.length) {
      const foot = h('div', { class: 'modal-foot' });
      for (const a of actions) {
        foot.append(h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), text: a.label, onclick: () => close(collect ? collect(box) : a.value) }));
      }
      box.append(foot);
    }
    mask.append(box);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(null); });
    document.addEventListener('keydown', onKey);
    document.body.append(mask);
    if (onMount) onMount(box);
    else setTimeout(() => box.querySelector('textarea, input, button')?.focus(), 30);
  });
}

function imageRatio(dataUrl) {
  return new Promise((res) => {
    const im = new Image();
    im.onload = () => res((im.naturalWidth || 1) / (im.naturalHeight || 1));
    im.onerror = () => res(2.6);
    im.src = dataUrl;
  });
}

async function pickImage() {
  const dataUrl = await new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return resolve(null);
      resolve(await blobToDataURL(f));
    });
    document.body.append(input);
    input.click();
  });
  if (!dataUrl) return null;
  S.assetRatio = await imageRatio(dataUrl);
  return dataUrl;
}

/** 手写签名：裁掉四周空白，返回 dataURL 与宽高比，放上去不会一片白边 */
async function pickSignature() {
  const sig = await signatureModal();
  if (!sig) return null;
  S.lastSignature = sig.dataUrl;
  S.assetRatio = sig.ratio;
  return sig;
}

/** 把画布上的笔迹裁到实际范围（四周留一点边），返回 PNG 与宽高比 */
function trimInk(canvas) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { dataUrl: canvas.toDataURL('image/png'), ratio: 560 / 170 };
  const pad = 6;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { dataUrl: out.toDataURL('image/png'), ratio: out.width / out.height };
}

function signatureModal() {
  return new Promise((resolve) => {
    const canvas = h('canvas', { width: 560, height: 170 });
    const pad = h('div', { class: 'sigpad' }, canvas, h('div', { class: 'ph2', text: '在这里手写签名' }));
    const body = h('div', {}, pad, h('p', { class: 'muted', style: { marginTop: '10px', fontSize: '11.5px' }, text: '签名会以 PNG 方式写入页面内容，不做身份认证用途。' }));
    let drawing = false, dirty = false;
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.6;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#111';
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
    };
    canvas.addEventListener('pointerdown', (e) => {
      drawing = true;
      dirty = true;
      const [x, y] = pos(e);
      ctx.beginPath();
      ctx.moveTo(x, y);
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      const [x, y] = pos(e);
      ctx.lineTo(x, y);
      ctx.stroke();
    });
    canvas.addEventListener('pointerup', () => (drawing = false));
    const mask = h('div', { class: 'modal-mask' });
    const box = h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('span', { html: icon('signature', 18) }), h('h3', { text: '手写签名' })),
      h('div', { class: 'modal-body' }, body),
      h('div', { class: 'modal-foot' },
        h('button', { class: 'btn', text: '清除', onclick: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; } }),
        h('button', { class: 'btn', text: '取消', onclick: () => { mask.remove(); resolve(null); } }),
        h('button', { class: 'btn primary', text: '使用签名', onclick: () => {
          if (!dirty) return toast('先写一个签名', 'err');
          const out = trimInk(canvas);
          mask.remove();
          resolve(out);
        } }),
      ),
    );
    mask.append(box);
    document.body.append(mask);
  });
}

/* ────────────────────────────────────────────────────────────
   菜单
   ──────────────────────────────────────────────────────────── */
const MENUS = [
  ['文件', [
    ['打开…', 'Ctrl+O', 'open', 'open'],
    ['保存', 'Ctrl+S', 'save', 'save'],
    ['另存为…', 'Ctrl+Shift+S', 'save', 'saveAs'],
    '-',
    ['导出图片…', '', 'image', 'exportImages'],
    ['导出文本…', '', 'text', 'exportText'],
    ['打印…', 'Ctrl+P', 'print', 'print'],
    '-',
    ['文档属性', 'Ctrl+D', 'info', 'props'],
    ['关闭标签', 'Ctrl+W', 'close', 'closeTab'],
    '-',
    ['退出', 'Alt+F4', 'external', 'quit'],
  ]],
  ['编辑', [
    ['撤销', 'Ctrl+Z', 'undo', 'undo'],
    ['重做', 'Ctrl+Y', 'redo', 'redo'],
    '-',
    ['查找', 'Ctrl+F', 'search', 'search'],
    ['全选页面', '', 'selectAll', 'selectAllPages'],
  ]],
  ['视图', [
    ['适合宽度', 'Ctrl+2', 'fitWidth', 'fitWidth'],
    ['适合页面', 'Ctrl+1', 'fitPage', 'fitPage'],
    ['实际大小', 'Ctrl+0', 'fit', 'actualSize'],
    '-',
    ['放大', 'Ctrl+=', 'zoomIn', 'zoomIn'],
    ['缩小', 'Ctrl+-', 'zoomOut', 'zoomOut'],
    '-',
    ['向右旋转视图', 'Ctrl+]', 'rotateCw', 'rotateView'],
    ['演示模式', 'F11', 'presentation', 'present'],
    ['切换主题', '', 'moon', 'theme'],
    ['工具面板', '', 'panelRight', 'toggleTools'],
  ]],
  ['文档', [
    ['旋转所选页 +90°', '', 'rotateCw', 'rotatePage'],
    ['删除所选页', '', 'trash', 'deletePage'],
    ['提取所选页…', '', 'extract', 'extractPages'],
    ['插入 PDF…', '', 'merge', 'insertPdf'],
    '-',
    ['压缩 / 优化…', '', 'compress', 'toolCompress'],
    ['应用修订…', '', 'redact', 'toolRedact'],
  ]],
  ['注释', [
    ['高亮', '', 'highlight', 'toolHighlight'],
    ['下划线', '', 'underline', 'toolUnderline'],
    ['删除线', '', 'strike', 'toolStrike'],
    ['便签', '', 'note', 'toolNote'],
    ['文本框', '', 'text', 'toolText'],
    ['手绘', '', 'pen', 'toolInk'],
    ['签名…', '', 'signature', 'toolSign'],
  ]],
  ['工具', [
    ['所有工具', '', 'tools', 'allTools'],
    ['合并文件…', '', 'merge', 'toolMerge'],
    ['填写和签名', '', 'form', 'toolFill'],
    ['导出', '', 'download', 'toolExport'],
    ['优化 PDF', '', 'compress', 'toolCompress'],
    ['保护（未实现）', '', 'lock', 'toolProtect'],
  ]],
  ['帮助', [
    ['键盘快捷键', '', 'keyboard', 'shortcuts'],
    ['关于 MiniPDF', '', 'info', 'about'],
  ]],
];

const ACTIONS = {
  open: openDialog,
  save: () => saveDoc(),
  saveAs: () => saveDoc({ as: true }),
  exportImages, exportText, print: printDoc,
  props: () => { S.sidePanel = 'props'; S.sideOpen = true; $('#sidebar').classList.remove('collapsed'); renderSidebar(); },
  closeTab: () => active && closeDoc(active.id),
  quit: () => P.win.close(),
  undo, redo,
  search: () => { S.sidePanel = 'search'; S.sideOpen = true; $('#sidebar').classList.remove('collapsed'); renderSidebar(); },
  selectAllPages: () => { S.organize = true; active && active.pages.forEach((_, i) => S.selectedPages.add(i)); S.sidePanel = 'thumbs'; renderSidebar(); openToolPanel('organize'); },
  fitWidth: () => viewer.applyScale('fit-width', 0, { keepAnchor: true }),
  fitPage: () => viewer.applyScale('fit-page', 0, { keepAnchor: true }),
  actualSize: () => viewer.applyScale('custom', 1, { keepAnchor: true }),
  zoomIn: () => viewer.zoomBy(1.2),
  zoomOut: () => viewer.zoomBy(1 / 1.2),
  rotateView: () => viewer.rotate(90),
  present: togglePresent,
  theme: toggleTheme,
  toggleTools: toggleTools,
  rotatePage: () => rotateSelected(90, true),
  deletePage: () => deleteSelected(true),
  extractPages: extractSelected,
  insertPdf,
  toolCompress: () => openToolPanel('compress'),
  toolRedact: () => openToolPanel('redact'),
  toolHighlight: () => setTool('highlight'),
  toolUnderline: () => setTool('underline'),
  toolStrike: () => setTool('strikeout'),
  toolNote: () => handleToolButton('note'),
  toolText: () => handleToolButton('textbox'),
  toolInk: () => setTool('ink'),
  toolSign: () => handleToolButton('sign'),
  allTools: () => openToolPanel(null),
  toolMerge: () => openToolPanel('merge'),
  toolFill: () => openToolPanel('fill'),
  toolExport: () => openToolPanel('export'),
  toolProtect: () => openToolPanel('protect'),
  'zoom-menu': () => {
    openMenu($('#zoomLabel'), [
      ['适合宽度', 'Ctrl+2', 'fitWidth', 'fitWidth'],
      ['适合页面', 'Ctrl+1', 'fitPage', 'fitPage'],
      ['实际大小', 'Ctrl+0', 'fit', 'actualSize'],
      '-',
      ['50%', '', 'minus', 'zoom50'],
      ['75%', '', 'minus', 'zoom75'],
      ['100%', '', 'fit', 'zoom100'],
      ['125%', '', 'plus', 'zoom125'],
      ['150%', '', 'plus', 'zoom150'],
      ['200%', '', 'plus', 'zoom200'],
      ['400%', '', 'zoomIn', 'zoom400'],
    ]);
  },
  zoom50: () => viewer.applyScale('custom', 0.5, { keepAnchor: true }),
  zoom75: () => viewer.applyScale('custom', 0.75, { keepAnchor: true }),
  zoom100: () => viewer.applyScale('custom', 1, { keepAnchor: true }),
  zoom125: () => viewer.applyScale('custom', 1.25, { keepAnchor: true }),
  zoom150: () => viewer.applyScale('custom', 1.5, { keepAnchor: true }),
  zoom200: () => viewer.applyScale('custom', 2, { keepAnchor: true }),
  zoom400: () => viewer.applyScale('custom', 4, { keepAnchor: true }),
  annotbar: () => { S.barPinned = !S.barPinned; updateAnnotBar(); },
  refreshPanel: () => renderSidebar(),
  organizePanel: () => { S.organize = true; S.sidePanel = 'thumbs'; S.sideOpen = true; $('#sidebar').classList.remove('collapsed'); renderSidebar(); openToolPanel('organize'); },
  hideSide: () => { S.sideOpen = false; $('#sidebar').classList.add('collapsed'); },
  shortcuts: showShortcuts,
  about: showAbout,
};

function buildMenubar() {
  const bar = $('#menubar');
  bar.replaceChildren();
  for (const [name, items] of MENUS) {
    const btn = h('button', { class: 'menu-btn', text: name });
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      openMenu(btn, items);
    });
    bar.append(btn);
  }
}

let openMenuEl = null;
function openMenu(anchor, items) {
  closeMenu();
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'menu' });
  const rects = [];
  for (const it of items) {
    if (it === '-') {
      menu.append(h('div', { class: 'menu-sep' }));
      continue;
    }
    const [label, sc, ic, act] = it;
    const disabled = ['save', 'saveAs', 'print', 'exportImages', 'exportText', 'props', 'closeTab', 'undo', 'redo', 'fitWidth', 'fitPage', 'actualSize', 'zoomIn', 'zoomOut', 'rotateView', 'rotatePage', 'deletePage', 'extractPages', 'insertPdf'].includes(act) && !active;
    menu.append(h('button', {
      class: 'menu-item' + (disabled ? ' disabled' : ''),
      onclick: () => { closeMenu(); ACTIONS[act] && ACTIONS[act](); },
    },
      h('span', { html: icon(ic, 16) }),
      h('span', { text: label }),
      sc ? h('span', { class: 'sc', text: sc }) : null,
    ));
  }
  menu.style.visibility = 'hidden';
  $('#overlayRoot').append(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(r.left, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(r.bottom + 2, window.innerHeight - mh - 8) + 'px';
  menu.style.visibility = '';
  anchor.classList.add('open');
  openMenuEl = { menu, anchor };
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
}

function outside(e) {
  if (!openMenuEl) return;
  if (openMenuEl.menu.contains(e.target) || openMenuEl.anchor.contains(e.target)) return;
  closeMenu();
}
function closeMenu() {
  if (!openMenuEl) return;
  openMenuEl.menu.remove();
  openMenuEl.anchor.classList.remove('open');
  openMenuEl = null;
  document.removeEventListener('mousedown', outside, true);
}

/* ────────────────────────────────────────────────────────────
   主题 / 演示 / 面板
   ──────────────────────────────────────────────────────────── */
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  localStorage.setItem('minipdf.theme', S.theme);
  const b = $('[data-act="theme"]');
  if (b) b.innerHTML = icon(S.theme === 'dark' ? 'sun' : 'moon', 18);
}
function toggleTheme() { S.theme = S.theme === 'dark' ? 'light' : 'dark'; applyTheme(); }

function toggleTools() {
  S.toolsOpen = !S.toolsOpen;
  $('#toolsPanel').classList.toggle('collapsed', !S.toolsOpen);
}

async function togglePresent() {
  document.body.classList.toggle('present');
  const on = document.body.classList.contains('present');
  if (on) {
    viewer.applyScale('fit-page', 0);
    $('#toolsPanel').classList.add('collapsed');
  } else {
    $('#toolsPanel').classList.toggle('collapsed', !S.toolsOpen);
  }
  await P.win.fullscreen();
}

async function showShortcuts() {
  const rows = [
    ['打开 / 保存 / 另存为', 'Ctrl+O / Ctrl+S / Ctrl+Shift+S'],
    ['打印', 'Ctrl+P'],
    ['关闭标签 / 切换标签', 'Ctrl+W / Ctrl+Tab'],
    ['查找', 'Ctrl+F'],
    ['撤销 / 重做', 'Ctrl+Z / Ctrl+Y'],
    ['缩放', 'Ctrl+= / Ctrl+- / Ctrl+0'],
    ['适合宽度 / 适合页面', 'Ctrl+2 / Ctrl+1'],
    ['旋转视图', 'Ctrl+]'],
    ['全屏演示', 'F11'],
    ['抓手 / 选择', 'H / V'],
    ['删除选中注释', 'Delete'],
  ];
  await modal({
    title: '键盘快捷键',
    iconName: 'keyboard',
    body: h('div', {}, ...rows.map(([k, v]) => h('div', { class: 'prop-row' }, h('span', { class: 'k', text: k, style: { width: '180px' } }), h('span', { class: 'v', text: v })))),
    actions: [{ label: '知道了', value: 'ok', primary: true }],
    wide: true,
  });
}

async function showAbout() {
  const info = await P.info();
  await modal({
    title: '关于 MiniPDF',
    iconName: 'info',
    body: h('div', {},
      h('p', { html: '<b>MiniPDF 1.0.1</b> — 用同一套界面复刻 Acrobat 的阅读、注释、页面编排与填写签名工作流。' }),
      h('p', { class: 'muted', text: `Electron ${info.electron} · Chromium ${info.chrome} · pdf.js 4.10 · pdf-lib 1.17` }),
      h('p', { class: 'muted', text: 'PDF 渲染由 pdf.js 完成，写回由 pdf-lib 完成；所有处理都在本机。' }),
      h('p', { class: 'muted', text: `Agent 桥：http://127.0.0.1:${info.bridgePort || 7857}/current_view` }),
    ),
    actions: [{ label: '关闭', value: 'ok', primary: true }],
  });
}

/* ────────────────────────────────────────────────────────────
   全局事件
   ──────────────────────────────────────────────────────────── */
function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach((el) => {
    const name = el.dataset.icon;
    el.innerHTML = icon(name, 18);
    el.removeAttribute('data-icon');
  });
}

function bindUI() {
  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act && ACTIONS[act.dataset.act]) ACTIONS[act.dataset.act]();
  });
  $$('[data-win]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.win;
    if (a === 'minimize') P.win.minimize();
    else if (a === 'maximize') P.win.maximize();
    else if (a === 'close') P.win.close();
  }));
  $('#titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, .doc-tab')) return;
    P.win.maximize();
  });
  $('#tabNew').addEventListener('click', openDialog);

  $$('#rail .rail-btn').forEach((b) => b.addEventListener('click', () => {
    const panel = b.dataset.panel;
    if (panel === S.sidePanel && S.sideOpen) {
      S.sideOpen = false;
      $('#sidebar').classList.add('collapsed');
      return;
    }
    S.sidePanel = panel;
    S.sideOpen = true;
    $('#sidebar').classList.remove('collapsed');
    if (panel === 'thumbs' && S.organize === false) S.organize = false;
    renderSidebar();
  }));
  $('#sideClose').addEventListener('click', () => {
    S.sideOpen = false;
    $('#sidebar').classList.add('collapsed');
  });
  $('#sideMore').addEventListener('click', (e) => {
    openMenu(e.currentTarget, [
      ['刷新面板', '', 'redo', 'refreshPanel'],
      ['组织页面', '', 'pages', 'organizePanel'],
      ['收起侧栏', '', 'close', 'hideSide'],
    ]);
  });

  $$('#toolModes .tb-icon').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  $('#pageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      viewer.goToPage(Number($('#pageInput').value) || 1);
      e.target.blur();
    }
  });
  $('#pgPrev').addEventListener('click', () => viewer.goToPage((active?.ui.pageIndex || 0)));
  $('#pgNext').addEventListener('click', () => viewer.goToPage((active?.ui.pageIndex || 0) + 2));

  const qs = $('#quickSearch');
  qs.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      S.sidePanel = 'search';
      S.sideOpen = true;
      $('#sidebar').classList.remove('collapsed');
      renderSidebar();
      runSearch(qs.value, false);
    }
  });
  qs.addEventListener('input', debounce(() => {
    if (!active) return;
    if (qs.value.trim().length >= 2) {
      S.sidePanel = 'search';
      S.sideOpen = true;
      $('#sidebar').classList.remove('collapsed');
      renderSidebar();
      const inp = $('#sideBody .search-box input');
      if (inp) inp.value = qs.value;
      runSearch(qs.value, false);
    }
  }, 520));

  $('#clearRecent').addEventListener('click', async () => { await P.recentClear(); renderRecent(); });
  $('#appVer').textContent = 'MiniPDF 1.0.1 · pdf.js + pdf-lib';

  // 拖放文件
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth++;
    $('#dropMask').classList.remove('hidden');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropMask').classList.add('hidden');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('#dropMask').classList.add('hidden');
    const files = Array.from(e.dataTransfer.files || []).filter((f) => /\.pdf$/i.test(f.name));
    for (const f of files) {
      const buf = new Uint8Array(await f.arrayBuffer());
      await openFromBytes(buf, { name: f.name });
    }
  });

  // 快捷键
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('present')) {
      document.body.classList.remove('present');
      P.win.fullscreen();
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'o') { e.preventDefault(); openDialog(); }
    else if (mod && k === 's') { e.preventDefault(); e.shiftKey ? saveDoc({ as: true }) : saveDoc(); }
    else if (mod && k === 'w') { e.preventDefault(); active && closeDoc(active.id); }
    else if (mod && k === 'p') { e.preventDefault(); printDoc(); }
    else if (mod && k === 'f') { e.preventDefault(); $('#quickSearch').focus(); $('#quickSearch').select(); }
    else if (mod && k === 'z') { e.preventDefault(); undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && (k === '=' || k === '+')) { e.preventDefault(); viewer.zoomBy(1.2); }
    else if (mod && k === '-') { e.preventDefault(); viewer.zoomBy(1 / 1.2); }
    else if (mod && k === '0') { e.preventDefault(); viewer.applyScale('custom', 1, { keepAnchor: true }); }
    else if (mod && k === '1') { e.preventDefault(); viewer.applyScale('fit-page', 0, { keepAnchor: true }); }
    else if (mod && k === '2') { e.preventDefault(); viewer.applyScale('fit-width', 0, { keepAnchor: true }); }
    else if (mod && k === ']') { e.preventDefault(); viewer.rotate(90); }
    else if (k === 'f11') { e.preventDefault(); togglePresent(); }
    else if (mod && k === 'tab') { e.preventDefault(); cycleTab(e.shiftKey ? -1 : 1); }
    else if (!mod && !e.target.matches('input, textarea, [contenteditable]')) {
      if (k === 'h') setTool('hand');
      else if (k === 'v') setTool('select');
      else if (k === 'f3') { e.preventDefault(); gotoHit((active?.currentHit || 0) + 1); }
      else if (k === 'delete' && viewer.selectedId) { e.preventDefault(); deleteAnnot(viewer.selectedId); }
    }
  });

  // 窗口尺寸变化时刷新缩放百分比
  window.addEventListener('resize', () => {
    if (active) $('#stZoom').textContent = Math.round(viewer.scale * 100) + '%';
  });
}

function cycleTab(delta) {
  if (S.docs.length < 2) return;
  const i = S.docs.findIndex((d) => d.id === S.activeId);
  const next = (i + delta + S.docs.length) % S.docs.length;
  activateDoc(S.docs[next].id);
}

function updateStatus() {
  const d = active;
  if (!d) return;
  $('#stFile').textContent = (d.path || d.name) + (d.dirty ? ' *' : '');
  $('#stDirty').classList.toggle('hidden', !d.dirty);
  $('#pageTotal').textContent = String(d.numPages);
  $('#stSize').textContent = `${Math.round(d.pages[viewer.currentIndex()]?.w || 0)}×${Math.round(d.pages[viewer.currentIndex()]?.h || 0)} pt`;
  $('#stZoom').textContent = Math.round(viewer.scale * 100) + '%';
}

/* ────────────────────────────────────────────────────────────
   Agent 桥（REA GUI 协议骨架）
   ──────────────────────────────────────────────────────────── */
function bridgeCurrentView() {
  const d = active;
  return {
    app: 'MiniPDF',
    document: d ? { name: d.name, path: d.path, pages: d.numPages, dirty: d.dirty, saved: !!d.path } : null,
    page: d ? viewer.currentIndex() + 1 : null,
    zoom: Math.round(viewer.scale * 100) / 100,
    tool: S.tool,
    panel: S.sidePanel,
    selection: viewer.selectedId ? d.annots.find((a) => a.id === viewer.selectedId) || null : null,
    annotations: d ? d.annots.length : 0,
    redactions: d ? d.redacts.length : 0,
    toolPanel: S.panelTool,
  };
}

function registerBridge() {
  P.onBridgeCall(async ({ id, tool, args }) => {
    try {
      let result;
      if (tool === 'current_view') {
        result = bridgeCurrentView();
      } else if (tool === 'open_target') {
        const d = active;
        if (!d) throw new Error('没有打开的文档');
        const page = clamp(Number(args.page) || 1, 1, d.numPages);
        if (args.rect) await viewer.scrollToRect(page, args.rect);
        else viewer.goToPage(page);
        if (args.annotId) {
          viewer.selectedId = args.annotId;
          viewer.renderAnnotations();
        }
        result = `已切到第 ${page} 页`;
      } else if (tool === 'set_view') {
        if (args.panel) { S.sidePanel = args.panel; S.sideOpen = true; $('#sidebar').classList.remove('collapsed'); renderSidebar(); }
        if (args.zoom === 'fit-width') viewer.applyScale('fit-width', 0, { keepAnchor: true });
        else if (args.zoom === 'fit-page') viewer.applyScale('fit-page', 0, { keepAnchor: true });
        else if (Number(args.zoom)) viewer.applyScale('custom', Number(args.zoom), { keepAnchor: true });
        if (args.tool) setTool(args.tool);
        if (args.theme) { S.theme = args.theme; applyTheme(); }
        result = `视图已更新：${JSON.stringify(bridgeCurrentView())}`;
      } else if (tool === 'annotate') {
        const d = active;
        if (!d) throw new Error('没有打开的文档');
        const page = clamp(Number(args.page) || viewer.currentIndex() + 1, 1, d.numPages);
        const rect = args.rect || [72, 72, 260, 100];
        const a = createAnnot({
          page, type: args.type || 'note', rects: [rect],
          color: args.color || S.color, content: args.content || '',
          points: args.points || null, strokeWidth: args.strokeWidth || 2,
        });
        result = { ok: true, id: a.id, page, note: '已在页面写入注释，Ctrl+S 才会落盘' };
      } else if (tool === 'propose_patch') {
        S.suggestions.push({ text: args.text || '', ts: Date.now() });
        toast('Agent 建议了一条改动（未应用）');
        result = { ok: true, applied: false, note: '建议已记录，等待用户在界面确认' };
      } else {
        throw new Error(`不支持的工具 ${tool}`);
      }
      P.bridgeResult({ id, ok: true, result });
    } catch (err) {
      P.bridgeResult({ id, ok: false, error: err.message });
    }
  });
  P.bridgeReady();
}

/* ────────────────────────────────────────────────────────────
   自检钩子
   ──────────────────────────────────────────────────────────── */
window.__minipdfSmoke = async (scene = 'read') => {
  const out = { scene, steps: [] };
  try {
    if (scene !== 'welcome' && scene !== 'startup') {
      const res = await fetch('/samples/sample.pdf');
      const buf = new Uint8Array(await res.arrayBuffer());
      const doc = await openFromBytes(buf, { name: 'sample.pdf' });
      if (!doc) throw new Error('open failed: ' + (window.__lastOpenError || 'unknown'));
      out.steps.push('open');
      await new Promise((r) => setTimeout(r, 1200));
    }

    if (scene === 'search') {
      S.sidePanel = 'search';
      S.sideOpen = true;
      $('#sidebar').classList.remove('collapsed');
      await runSearch('render', false);
      out.steps.push('search');
      await new Promise((r) => setTimeout(r, 700));
    } else if (scene === 'comments') {
      S.silentNote = true;
      createAnnot({ page: 1, type: 'highlight', rects: [[72, 640, 520, 655]], color: '#ffe14d', content: '重点：这段说明文字层与命中矩形' });
      createAnnot({ page: 1, type: 'note', rects: [[72, 560, 92, 580]], color: '#ff9f1a', content: '这里应该加一个脚注' });
      createAnnot({ page: 1, type: 'underline', rects: [[72, 470, 470, 483]], color: '#e8453c', content: '' });
      createAnnot({ page: 1, type: 'rect', rects: [[72, 380, 300, 440]], color: '#1473e6', content: '' });
      S.sidePanel = 'comments';
      S.sideOpen = true;
      $('#sidebar').classList.remove('collapsed');
      renderSidebar();
      viewer.renderAnnotations();
      out.steps.push('comments');
      S.silentNote = false;
      await new Promise((r) => setTimeout(r, 500));
    } else if (scene === 'organize') {
      S.organize = true;
      S.sidePanel = 'thumbs';
      S.sideOpen = true;
      $('#sidebar').classList.remove('collapsed');
      S.selectedPages.add(1);
      S.selectedPages.add(2);
      renderSidebar();
      openToolPanel('organize');
      out.steps.push('organize');
      await new Promise((r) => setTimeout(r, 500));
    } else if (scene === 'signature') {
      signatureModal();
      out.steps.push('signature');
      await new Promise((r) => setTimeout(r, 500));
    } else if (scene === 'zoom') {
      viewer.applyScale('custom', 2, { keepAnchor: true });
      out.steps.push('zoom');
      await new Promise((r) => setTimeout(r, 900));
    } else if (scene === 'note-modal') {
      S.tool = 'note';
      await promptNote({ id: 'demo', page: 1, type: 'note', rects: [[72, 560, 92, 580]] });
      out.steps.push('note');
    } else if (scene === 'select') {
      const spans = Array.from(document.querySelectorAll('.page .textLayer span')).filter((x) => x.textContent.trim().length > 3);
      out.spans = spans.length;
      if (spans.length >= 3) {
        const range = document.createRange();
        range.setStart(spans[2].firstChild, 0);
        range.setEnd(spans[4].firstChild, spans[4].textContent.length);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        viewer.setTool('highlight');
        const selInfo = window.getSelection();
        out.selText = selInfo.toString().slice(0, 40);
        out.selRects = selInfo.rangeCount ? Array.from(selInfo.getRangeAt(0).getClientRects()).length : -1;
        out.pdfRects = viewer.selectionToPdf();
        viewer.onMouseUp({ target: spans[2] });
        out.selectedAnnots = active.annots.length;
        out.selectedRects = active.annots[0] ? active.annots[0].rects.length : 0;
        await new Promise((r) => setTimeout(r, 400));
        out.annotInPage = !!document.querySelector('.annot.hl');
        out.spanText = spans[2].textContent;
        out.selAgain = window.getSelection().toString();
      }
      out.steps.push('select');
    } else if (scene === 'undo') {
      S.silentNote = true;
      createAnnot({ page: 1, type: 'highlight', rects: [[72, 640, 520, 655]], color: '#ffe14d', content: 'undo' });
      S.silentNote = false;
      out.afterCreate = active.annots.length;
      await undo();
      out.afterUndo = active.annots.length;
      await redo();
      out.afterRedo = active.annots.length;
      out.steps.push('undo');
    } else if (scene === 'multi') {
      const r = await P.readFile('D:/REA/minipdf/build/annotations.pdf');
      await openFromBytes(r.data, { path: r.path, name: r.name });
      await new Promise((r2) => setTimeout(r2, 900));
      out.tabs = document.querySelectorAll('.doc-tab').length;
      out.activeName = active.name;
      out.names = S.docs.map((d) => d.name);
      out.steps.push('multi');
    } else if (scene === 'edit' || scene === 'edit-saved' || scene === 'edit-zoom' || scene === 'edit-clean') {
      const clean = scene === 'edit-clean';
      // 1) 文本框：从工具条上的按钮点进去，再点页面
      openToolPanel('annotate');
      const tbBtn = document.querySelector('#annotBar button[data-tool="textbox"]');
      out.barButton = !!tbBtn;
      if (tbBtn) tbBtn.click(); else setTool('textbox');
      await new Promise((r) => setTimeout(r, 150));
      out.toolAfterClick = S.tool;
      const pageEl = document.querySelector('.page');
      const pr = pageEl.getBoundingClientRect();
      const cx = pr.left + 140, cy = pr.top + (clean ? 470 : 200);
      const pe = (type) => new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: cx, clientY: cy,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
      });
      pageEl.dispatchEvent(pe('pointerdown'));
      pageEl.dispatchEvent(pe('pointerup'));
      await new Promise((r) => setTimeout(r, 250));
      out.boxCreated = active.annots.filter((a) => a.type === 'textbox').length;
      const box = document.querySelector('.annot.textbox');
      out.boxInDom = !!box;
      if (box) {
        box.focus();
        box.textContent = '编辑功能测试：第一行中文，第二行用来验证自动换行与高度增长，第三行再长一点看看会不会被裁掉。';
        box.dispatchEvent(new Event('input', { bubbles: true }));
        out.focused = document.activeElement === box;
        // 在框里按退格只能删字，不能把整个框删掉
        const before = active.annots.filter((a) => a.type === 'textbox').length;
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
        out.backspaceKeptBox = active.annots.filter((a) => a.type === 'textbox').length === before;
      }
      const tb = active.annots.find((a) => a.type === 'textbox');
      // 回车在 contenteditable 里是 <div>，取文本要还原成 \n
      if (box) {
        box.innerHTML = '第一行文字<div>第二行：按回车换行</div><div>第三行</div>';
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      out.multiLine = tb ? tb.content.split('\n').length : 0;
      out.textContent = tb ? tb.content.slice(0, 12) : null;
      out.textRect = tb ? tb.rects[0].map((v) => +v.toFixed(1)) : null;
      out.grewHeight = tb ? +(tb.rects[0][3] - tb.rects[0][1]).toFixed(1) : 0;

      // 2) 签名：宽高比不能被拉扁
      if (clean) { out.signRatio = null; }
      const sc = document.createElement('canvas');
      sc.width = 240; sc.height = 80;
      const sctx = sc.getContext('2d');
      sctx.strokeStyle = '#111'; sctx.lineWidth = 5;
      sctx.beginPath(); sctx.moveTo(20, 55); sctx.quadraticCurveTo(90, 10, 220, 45); sctx.stroke();
      if (!clean) {
      S.lastSignature = sc.toDataURL('image/png');
      S.assetRatio = 3;
      setTool('sign');
      pageEl.dispatchEvent(pe('pointerdown'));
      pageEl.dispatchEvent(pe('pointerup'));
      await new Promise((r) => setTimeout(r, 200));
      }
      const sg = active.annots.find((a) => a.type === 'sign');
      out.signRatio = sg ? +((sg.rects[0][2] - sg.rects[0][0]) / (sg.rects[0][3] - sg.rects[0][1])).toFixed(2) : null;

      // 2b) 图片：宽图 400x100 放上去应保持 4:1
      const ic = document.createElement('canvas');
      ic.width = 400; ic.height = 100;
      const ictx = ic.getContext('2d');
      ictx.fillStyle = '#1473e6'; ictx.fillRect(0, 0, 400, 100);
      S.pendingImage = ic.toDataURL('image/png');
      S.assetRatio = await imageRatio(S.pendingImage);
      setTool('image');
      pageEl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: pr.left + 420, clientY: pr.top + 520, pointerId: 3, pointerType: 'mouse', isPrimary: true }));
      pageEl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: pr.left + 420, clientY: pr.top + 520, pointerId: 3, pointerType: 'mouse', isPrimary: true }));
      await new Promise((r) => setTimeout(r, 200));
      const im = active.annots.filter((a) => a.type === 'image').pop();
      out.imageRatio = im ? +((im.rects[0][2] - im.rects[0][0]) / (im.rects[0][3] - im.rects[0][1])).toFixed(2) : null;

      // 3) 选择工具下能选中文本框（不能被重建掉焦点）
      setTool('select');
      await new Promise((r) => setTimeout(r, 120));
      const boxEl = document.querySelector('.annot.textbox');
      if (boxEl) {
        const br = boxEl.getBoundingClientRect();
        const opts2 = {
          bubbles: true, cancelable: true, clientX: br.left + 6, clientY: br.top + 6,
          pointerId: 2, pointerType: 'mouse', isPrimary: true,
        };
        boxEl.dispatchEvent(new PointerEvent('pointerdown', opts2));
        boxEl.dispatchEvent(new PointerEvent('pointerup', opts2));
        out.selected = !!viewer.selectedId && viewer.selectedId === (tb && tb.id);
        out.selectedClass = !!document.querySelector('.annot.textbox.selected');
        out.delBadge = !!document.querySelector('.annot.textbox .del');
      }

      // 4) 保存后：文字变成页面里的图片，那块区域真的被画上了东西
      const bytes = await ops.savePdf(active.bytes, active.annots.filter((a) => !a.inFile), {}, {});
      out.savedBytes = bytes.length;
      const re = await loadPdf(bytes);
      const ld = await window.PDFLib.PDFDocument.load(bytes);
      const res = ld.getPages()[0].node.Resources();
      const xo = res && res.lookup(window.PDFLib.PDFName.of('XObject'));
      out.imageXObjects = xo ? xo.keys().length : 0;
      const shot = await renderPageOffscreen(re.pdf, 1, 2);
      const sctx2 = shot.getContext('2d');
      const pageOne = await re.pdf.getPage(1);
      const vp2 = pageOne.getViewport({ scale: 2 });
      let dark = 0;
      if (tb) {
        const rr = vp2.convertToViewportRectangle(tb.rects[0]);
        const x0 = Math.max(0, Math.floor(Math.min(rr[0], rr[2])));
        const y0 = Math.max(0, Math.floor(Math.min(rr[1], rr[3])));
        const ww = Math.max(1, Math.ceil(Math.abs(rr[2] - rr[0])));
        const hh2 = Math.max(1, Math.ceil(Math.abs(rr[3] - rr[1])));
        const d2 = sctx2.getImageData(x0, y0, ww, hh2).data;
        for (let i = 0; i < d2.length; i += 4) if (d2[i] < 120 && d2[i + 1] < 120 && d2[i + 2] < 120) dark++;
      }
      out.darkPixels = dark;
      // 收窄宽度后高度应重新长高，而不是被裁
      if (tb) {
        const wide = tb.rects[0][3] - tb.rects[0][1];
        tb.rects[0][2] = tb.rects[0][0] + 110;
        viewer.renderAnnotations();
        await new Promise((r) => setTimeout(r, 120));
        viewer.syncTextboxHeights();
        out.narrow = { wideHeight: +wide.toFixed(1), narrowHeight: +(tb.rects[0][3] - tb.rects[0][1]).toFixed(1) };
      }
      // 白底擦除的 A/B：同一块区域，带白底应该更少"原文的黑色像素"
      const countDark = async (bts, rect) => {
        const dd = await loadPdf(bts);
        const shot2 = await renderPageOffscreen(dd.pdf, 1, 2);
        const pg = await dd.pdf.getPage(1);
        const v = pg.getViewport({ scale: 2 });
        const rr = v.convertToViewportRectangle(rect);
        const gx = Math.max(0, Math.floor(Math.min(rr[0], rr[2])));
        const gy = Math.max(0, Math.floor(Math.min(rr[1], rr[3])));
        const gw = Math.max(1, Math.ceil(Math.abs(rr[2] - rr[0])));
        const gh = Math.max(1, Math.ceil(Math.abs(rr[3] - rr[1])));
        const px = shot2.getContext('2d').getImageData(gx, gy, gw, gh).data;
        let n = 0;
        for (let i = 0; i < px.length; i += 4) if (px[i] < 120 && px[i + 1] < 120 && px[i + 2] < 120) n++;
        return n;
      };
      if (tb) {
        out.darkWithErase = await countDark(bytes, tb.rects[0]);
        out.darkNoErase = await countDark(await ops.savePdf(active.bytes, [{ ...tb, erase: false }], {}, {}), tb.rects[0]);
      }
      out.steps.push('edit');
      if (scene === 'edit-saved' || scene === 'edit-zoom' || scene === 'edit-clean') {
        await openFromBytes(bytes, { name: 'edit-saved.pdf' });
        await new Promise((r) => setTimeout(r, 900));
        viewer.goToPage(1, { instant: true });
        await new Promise((r) => setTimeout(r, 600));
        if (scene === 'edit-zoom' || scene === 'edit-clean') {
          viewer.applyScale('custom', 3, { keepAnchor: false });
          await new Promise((r) => setTimeout(r, 1200));
          if (tb) {
            const pp = await active.pdf.getPage(1);
            const vp3 = pp.getViewport({ scale: viewer.scale });
            const q = vp3.convertToViewportRectangle(tb.rects[0]);
            const el0 = viewer.pageEls[0];
            viewer.viewerEl.scrollTop = Math.max(0, el0.offsetTop + Math.min(q[1], q[3]) - 40);
          }
        }
        out.steps.push('edit-saved');
      }
    } else if (scene === 'savedview') {
      S.silentNote = true;
      createAnnot({ page: 1, type: 'highlight', rects: [[72, 640, 520, 655], [72, 620, 300, 635]], color: '#ffe14d', content: '双行高亮' });
      createAnnot({ page: 1, type: 'underline', rects: [[72, 560, 470, 573]], color: '#e8453c', content: '' });
      createAnnot({ page: 1, type: 'strikeout', rects: [[72, 520, 400, 533]], color: '#111111', content: '' });
      createAnnot({ page: 1, type: 'note', rects: [[470, 600, 490, 620]], color: '#ff9f1a', content: '这是一条中文便签，用来验证 UTF-16 写入' });
      createAnnot({ page: 1, type: 'ink', rects: [[300, 430, 460, 480]], color: '#1473e6', points: [[300, 470], [330, 440], [360, 480], [390, 445], [420, 478], [455, 450]], strokeWidth: 2 });
      createAnnot({ page: 1, type: 'rect', rects: [[72, 360, 300, 410]], color: '#2fb344', content: '' });
      createAnnot({ page: 1, type: 'arrow', rects: [[320, 360, 470, 410]], points: [[320, 370], [470, 405]], color: '#8e5bd8', strokeWidth: 2 });
      S.silentNote = false;
      const b = await ops.savePdf(active.bytes, active.annots.filter((a) => !a.inFile), {});
      await P.writeFile('D:/REA/minipdf/build/annotations.pdf', b);
      await openFromBytes(b, { name: 'annotations.pdf' });
      viewer.goToPage(1, { instant: true });
      await new Promise((r) => setTimeout(r, 1200));
      const page1 = await active.pdf.getPage(1);
      const list = await page1.getAnnotations({ intent: 'display' });
      out.bakedAnnots = list.filter((a) => ['Highlight', 'Underline', 'StrikeOut', 'Text', 'Ink', 'Square', 'Line'].includes(a.subtype)).map((a) => a.subtype);
      out.contents = list.filter((a) => a.subtype === 'Text').map((a) => (a.contentsObj && a.contentsObj.str) || a.contents);
      out.steps.push('savedview');
    } else if (scene === 'move') {
      await doMovePage(0, 2);
      await new Promise((r) => setTimeout(r, 900));
      const tc = await getTextContent(active.pdf, 1);
      out.page1Text = tc.items.map((i) => i.str).join(' ').slice(0, 60);
      out.steps.push('move');
    } else if (scene === 'redact') {
      const before = active.bytes.length;
      const t0 = await getTextContent(active.pdf, 1);
      out.textBefore = t0.items.map((i) => i.str).join('').length;
      const rb = await ops.rasterize(active.bytes, async (n, scale) => renderPageOffscreen(active.pdf, n, scale), {
        dpi: 150, quality: 0.85, affected: new Set([0]), redacts: [{ page: 1, rect: [60, 600, 540, 700] }],
      });
      out.redactedBytes = rb.length;
      const re = await loadPdf(rb);
      out.redactedPages = re.numPages;
      const t1 = await getTextContent(re.pdf, 1);
      out.textAfter = t1.items.map((i) => i.str).join('').length;
      out.steps.push('redact');
    } else if (scene === 'dark') {
      S.theme = 'dark';
      applyTheme();
      await new Promise((r) => setTimeout(r, 500));
      out.steps.push('dark');
    } else if (scene === 'forms') {
      viewer.goToPage(4, { instant: true });
      await new Promise((r) => setTimeout(r, 1200));
      const fields = document.querySelectorAll('.form-layer input, .form-layer select, .form-layer textarea');
      out.formInputs = fields.length;
      if (fields.length) {
        fields[0].value = 'Ada Lovelace';
        fields[0].dispatchEvent(new Event('change'));
        active.fields.fullName = 'Ada Lovelace';
      }
      out.fieldValues = JSON.parse(JSON.stringify(active.fields));
      const fb = await ops.savePdf(active.bytes, [], active.fields, {});
      const fdoc = await loadPdf(fb);
      const fp = await fdoc.pdf.getPage(4);
      const anns = await fp.getAnnotations({ intent: 'display' });
      out.savedFieldValue = (anns.find((a) => a.fieldName === 'fullName') || {}).fieldValue || null;
      out.annotSample = anns.filter((a) => a.subtype === 'Widget').map((a) => ({ f: a.fieldName, v: a.fieldValue, ft: a.fieldType }));
      const ld = await window.PDFLib.PDFDocument.load(fb);
      out.libFieldValue = ld.getForm().getTextField('fullName').getText();
      out.steps.push('forms');
    } else if (scene === 'pageops') {
      const before = active.pages[0].rotate;
      await rotateSelected(90, true);
      await new Promise((r) => setTimeout(r, 600));
      out.rotate = { before, after: active.pages[0].rotate };
      await new Promise((r) => setTimeout(r, 300));
      out.steps.push('pageops');
    } else if (scene === 'menu') {
      const btn = document.querySelector('#menubar .menu-btn');
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 40, clientY: 12 }));
      await new Promise((r) => setTimeout(r, 400));
      out.steps.push('menu');
    } else if (scene === 'edit-panel') {
      openToolPanel('edit');
      setTool('textbox');
      await new Promise((r) => setTimeout(r, 400));
      out.steps.push('edit-panel');
    } else if (scene === 'annotate-panel') {
      openToolPanel('annotate');
      setTool('highlight');
      await new Promise((r) => setTimeout(r, 400));
      out.steps.push('annotate-panel');
    } else if (scene === 'startup') {
      await new Promise((r) => setTimeout(r, 1200));
      out.steps.push('startup');
    } else if (scene === 'welcome') {
      out.steps.push('welcome');
      await new Promise((r) => setTimeout(r, 400));
    } else if (scene === 'io') {
      await openPath('D:/REA/minipdf/samples/sample.pdf', 'sample.pdf');
      await new Promise((r) => setTimeout(r, 900));
      S.silentNote = true;
      createAnnot({ page: 2, type: 'highlight', rects: [[72, 600, 400, 614]], color: '#ffe14d', content: 'io test' });
      S.silentNote = false;
      const outBytes = await ops.savePdf(active.bytes, active.annots.filter((a) => !a.inFile), {});
      const wr = await P.writeFile('D:/REA/minipdf/build/io-saved.pdf', outBytes);
      out.ioWrite = wr;
      const back = await P.readFile('D:/REA/minipdf/build/io-saved.pdf');
      out.ioBack = back && !back.error ? back.data.length : back;
      const re = await loadPdf(back.data);
      out.ioPages = re.numPages;
      out.ioKey = re.fingerprints && re.fingerprints[0];
      out.steps.push('io');
    }

    out.pages = active ? active.numPages : 0;
    out.debug = (() => {
      const pv = document.querySelector('#viewer');
      const els = document.querySelectorAll('.page');
      const first = els[0];
      const r = first && first.getBoundingClientRect();
      return {
        pageEls: els.length,
        rendered: document.querySelectorAll('.page[data-rendered="1"]').length,
        vw: pv.clientWidth,
        scale: Number(viewer.scale.toFixed(3)),
        firstW: r ? Math.round(r.width) : null,
        annots: active ? active.annots.length : 0,
        annotEls: document.querySelectorAll('.annot').length,
        hits: active ? active.searchHits.length : 0,
        toolCard: document.querySelectorAll('.tool-card').length,
        dirty: active ? active.dirty : null,
        tabDot: !!document.querySelector('.doc-tab .dot'),
        spanSample: (() => { const sp = document.querySelector('.page .textLayer span'); return sp ? { t: sp.textContent.slice(0, 30), len: sp.textContent.length, nodes: sp.childNodes.length } : null; })(),
      };
    })();
    out.libs = { pdfLib: !!window.PDFLib, root: !!$('#pages') };
    const bytes = await ops.savePdf(active ? active.bytes : new Uint8Array(await (await fetch('/samples/sample.pdf')).arrayBuffer()), active ? active.annots.filter((a) => !a.inFile) : [], {});
    out.savedBytes = bytes.length;
    const re = await loadPdf(bytes);
    out.savedPages = re.numPages;
    const p1 = await re.pdf.getPage(1);
    const anns = await p1.getAnnotations({ intent: 'display' });
    out.savedAnnots = anns.filter((a) => ['Highlight', 'Underline', 'StrikeOut', 'Text', 'Square', 'Ink', 'Line'].includes(a.subtype)).length;
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.error = (err && err.stack) || String(err);
    out.bootErrors = (window.__bootErrors || []).slice(-4);
  }
  return out;
};

/* ────────────────────────────────────────────────────────────
   启动
   ──────────────────────────────────────────────────────────── */
async function boot() {
  applyTheme();
  hydrateIcons();
  buildMenubar();
  bindUI();
  renderHomeTools();
  renderAnnotBar();
  renderToolsGrid();
  await renderRecent();
  const info = await P.info();
  const d = document.querySelector('.welcome-foot code');
  if (d) d.textContent = `127.0.0.1:${info.bridgePort || 7857}`;
  P.onCloseRequest(async () => {
    const dirty = S.docs.filter((d) => d.dirty);
    if (!dirty.length) return P.closeResponse(true);
    const ok = await modal({
      title: '还有未保存的改动',
      iconName: 'save',
      body: h('p', { text: `${dirty.map((d) => d.name).join('、')} 有未保存的改动。直接退出会丢失这些修改。` }),
      actions: [{ label: '取消', value: null }, { label: '仍然退出', value: 'quit', primary: true }],
    });
    P.closeResponse(ok === 'quit');
  });
  registerBridge();
  const openArg = new URLSearchParams(location.search).get('open');
  if (openArg) await openPath(openArg);
  if (S.docs.length === 0) showWelcome();
  updateUndoButtons();
  // 演示样式
  const style = document.createElement('style');
  style.textContent = `body.present #titlebar,body.present #toolbar,body.present #rail,body.present #sidebar,body.present #toolsPanel,body.present #statusbar{display:none!important}
  body.present #main{height:100vh}body.present #pages{padding:0}body.present .page{box-shadow:none}`;
  document.head.append(style);
}

boot();
