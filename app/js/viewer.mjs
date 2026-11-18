import { h, clamp, uid } from './util.mjs';
import { getPageViewport, renderPage, renderTextLayer, getWidgets } from './engine.mjs';
import { icon } from './icons.mjs';

const SEL_TOOLS = new Set(['highlight', 'underline', 'strikeout']);
const DRAW_TOOLS = new Set(['rect', 'arrow', 'ink', 'note', 'freetext', 'textbox', 'sign', 'image', 'redact']);
const COLOR_DEFAULT = '#ffe14d';

export class Viewer {
  constructor(opts) {
    this.viewerEl = opts.viewerEl;
    this.pagesEl = opts.pagesEl;
    this.cb = opts;
    this.doc = null;
    this.scale = 1;
    this.scaleMode = 'fit-width';
    this.fitValue = 0;
    this.viewRotation = 0;
    this.tool = 'select';
    this.selectedId = null;
    this.drag = null;
    this.pageEls = [];
    this._renderTokens = new WeakMap();
    this._scrollRaf = 0;
    this._lastPage = 0;

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.viewerEl,
      rootMargin: '700px 0px 700px 0px',
      threshold: 0.01,
    });

    this.viewerEl.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.viewerEl.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.viewerEl.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.pagesEl.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.pagesEl.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.pagesEl.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.pagesEl.addEventListener('pointercancel', () => this.cancelDrag());
    this.viewerEl.addEventListener('keydown', (e) => {
      const t = e.target;
      // 正在文本框里打字 / 表单里输入时，Delete、方向键都不能当作"操作注释"
      const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
      if (e.key === 'Escape') {
        this.cb.onEscape?.();
        if (typing && t.blur) t.blur();
        return;
      }
      if (typing) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) {
        e.preventDefault();
        this.cb.onDeleteAnnot?.(this.selectedId);
        return;
      }
      if (this.selectedId && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0;
        this.nudge(this.selectedId, dx, dy);
      }
    });
    window.addEventListener('resize', () => {
      clearTimeout(this._resizeT);
      this._resizeT = setTimeout(() => this.applyScale(this.scaleMode, this.fitValue, { keepAnchor: true }), 120);
    });

    // 面板展开/收起会改变可视宽度，适合宽度/页面需要跟着重算
    this._lastW = 0;
    this._ro = new ResizeObserver(() => {
      const w = this.viewerEl.clientWidth;
      if (!this.doc || Math.abs(w - this._lastW) < 8) return;
      this._lastW = w;
      if (this.scaleMode !== 'custom') this.applyScale(this.scaleMode, 0, { keepAnchor: true });
    });
    this._ro.observe(this.viewerEl);
  }

  /* ── 文档 ─────────────────────────────────────────────── */
  setDoc(doc, { restore = true } = {}) {
    this.observer.disconnect();
    this.doc = doc;
    this.viewRotation = doc.ui?.rotation || 0;
    this.selectedId = null;
    this.scaleMode = doc.ui?.scaleMode || 'fit-width';
    this.fitValue = doc.ui?.scale || 0;
    this.build(restore ? doc.ui : null);
  }

  clear() {
    this.observer.disconnect();
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    this.doc = null;
  }

  pageCount() {
    return this.doc ? this.doc.numPages : 0;
  }

  rotatedSize(page, rotation, scale = 1) {
    const r = (((page.rotate || 0) + rotation) % 360 + 360) % 360;
    const swap = r === 90 || r === 270;
    const w = (swap ? page.h : page.w) * scale;
    const hh = (swap ? page.w : page.h) * scale;
    return { w, h: hh };
  }

  computeFitScale(mode) {
    if (!this.doc) return 1;
    const availW = Math.max(240, this.viewerEl.clientWidth - 58);
    const availH = Math.max(240, this.viewerEl.clientHeight - 52);
    if (mode === 'fit-page') {
      const p = this.doc.pages[this.currentIndex()] || this.doc.pages[0];
      const s1 = this.rotatedSize(p, this.viewRotation, 1);
      return Math.min(availW / s1.w, availH / s1.h);
    }
    let maxW = 0;
    for (const p of this.doc.pages) maxW = Math.max(maxW, this.rotatedSize(p, this.viewRotation, 1).w);
    return availW / Math.max(1, maxW);
  }

  resolveScale() {
    if (this.scaleMode === 'fit-width') return this.computeFitScale('fit-width');
    if (this.scaleMode === 'fit-page') return this.computeFitScale('fit-page');
    return this.fitValue || 1;
  }

  build(ui) {
    const doc = this.doc;
    this.pagesEl.replaceChildren();
    this.pageEls = [];
    if (!doc) return;
    this.scale = this.resolveScale();

    for (let i = 0; i < doc.numPages; i++) {
      const size = this.rotatedSize(doc.pages[i], this.viewRotation, this.scale);
      const el = h('div', { class: 'page', dataset: { page: String(i) } });
      el.style.width = Math.round(size.w) + 'px';
      el.style.height = Math.round(size.h) + 'px';
      el.append(
        h('div', { class: 'ph', text: `第 ${i + 1} 页` }),
        h('canvas'),
        h('div', { class: 'textLayer' }),
        h('div', { class: 'annot-layer' }),
        h('div', { class: 'search-hits' }),
        h('div', { class: 'form-layer' }),
        h('div', { class: 'page-no', text: String(i + 1) }),
      );
      this.pagesEl.append(el);
      this.pageEls.push(el);
      this.observer.observe(el);
    }
    this.applyToolClass();
    this.cb.onZoom?.(this.scale, this.scaleMode);

    if (ui && ui.pageIndex > 0) {
      requestAnimationFrame(() => this.goToPage(ui.pageIndex + 1, { instant: true }));
    }
    requestAnimationFrame(() => {
      this.updateCurrentPage(true);
      this.renderVisible();
      this.renderAnnotations();
      this.renderSearchHits();
    });
  }

  async applyScale(mode, value, { keepAnchor = false } = {}) {
    if (!this.doc) return;
    const anchor = keepAnchor ? this.anchor() : null;
    this.scaleMode = mode;
    if (mode === 'custom') this.fitValue = clamp(value, 0.1, 8);
    this.scale = this.resolveScale();
    if (this.doc.ui) {
      this.doc.ui.scaleMode = mode;
      this.doc.ui.scale = mode === 'custom' ? this.fitValue : this.scale;
    }
    for (let i = 0; i < this.pageEls.length; i++) {
      const el = this.pageEls[i];
      const size = this.rotatedSize(this.doc.pages[i], this.viewRotation, this.scale);
      el.style.width = Math.round(size.w) + 'px';
      el.style.height = Math.round(size.h) + 'px';
      el.dataset.rendered = '';
      el.dataset.key = '';
      el.classList.remove('loaded');
      // 旧画布按新宽度拉伸，等重绘完成
    }
    this.renderAnnotations();
    this.renderSearchHits();
    this.cb.onZoom?.(this.scale, this.scaleMode);
    this.renderVisible();
    if (anchor) this.restoreAnchor(anchor);
  }

  zoomBy(factor) {
    const next = clamp(this.scale * factor, 0.1, 8);
    this.applyScale('custom', next, { keepAnchor: true });
  }

  rotate(delta) {
    this.viewRotation = ((this.viewRotation + delta) % 360 + 360) % 360;
    if (this.doc.ui) this.doc.ui.rotation = this.viewRotation;
    this.selectedId = null;
    this.build({ pageIndex: this.currentIndex() });
  }

  /* ── 渲染 ─────────────────────────────────────────────── */
  onIntersect(entries) {
    for (const e of entries) {
      if (e.isIntersecting) this.renderPageEl(e.target);
    }
    this.maybeUnload();
  }

  renderVisible() {
    const vr = this.viewerEl.getBoundingClientRect();
    for (const el of this.pageEls) {
      const r = el.getBoundingClientRect();
      if (r.bottom > vr.top - 700 && r.top < vr.bottom + 700) this.renderPageEl(el);
    }
  }

  async renderPageEl(el) {
    if (!this.doc || !el) return;
    const idx = Number(el.dataset.page);
    const key = `${this.scale.toFixed(4)}:${this.viewRotation}`;
    if (el.dataset.rendered === '1' && el.dataset.key === key) return;
    if (el._rendering) {
      el._rerender = true;
      return;
    }
    el._rendering = true;
    const token = (this._renderTokens.get(el) || 0) + 1;
    this._renderTokens.set(el, token);

    const n = idx + 1;
    try {
      if (el._task) {
        try { el._task.cancel(); } catch { /* 已结束 */ }
        el._task = null;
      }
      const vp = await getPageViewport(this.doc.pdf, n, this.scale, this.viewRotation);
      if (this._renderTokens.get(el) !== token) return;

      const canvas = el.querySelector('canvas');
      const textLayer = el.querySelector('.textLayer');
      const task = await renderPage(this.doc.pdf, n, canvas, vp, window.devicePixelRatio || 1);
      el._task = task;
      await task.promise;
      el._task = null;
      if (this._renderTokens.get(el) !== token) return;

      el.dataset.rendered = '1';
      el.dataset.token = String(token);
      el.dataset.key = key;
      el.classList.add('loaded');
      el._vp = vp;

      try {
        await renderTextLayer(this.doc.pdf, n, textLayer, vp);
      } catch (err) {
        console.warn('text layer failed', n, err && err.message);
      }

      this.renderAnnotationsFor(idx);
      this.renderSearchHitsFor(idx);
      this.buildFormLayer(idx, vp);
    } catch (err) {
      if (err && err.name !== 'RenderingCancelledException') console.warn('render failed', n, err && err.message);
    } finally {
      el._rendering = false;
      if (el._rerender) {
        el._rerender = false;
        setTimeout(() => this.renderPageEl(el), 0);
      }
    }
  }

  maybeUnload() {
    if (!this.doc) return;
    const cur = this.currentIndex();
    for (let i = 0; i < this.pageEls.length; i++) {
      if (Math.abs(i - cur) <= 4) continue;
      const el = this.pageEls[i];
      if (el.dataset.rendered !== '1') continue;
      el.dataset.rendered = '';
      el.classList.remove('loaded');
      const c = el.querySelector('canvas');
      c.width = 0;
      c.height = 0;
      el.querySelector('.textLayer').replaceChildren();
      el.querySelector('.form-layer').replaceChildren();
    }
  }

  /* ── 滚动 / 页码 ───────────────────────────────────────── */
  currentIndex() {
    if (!this.doc) return 0;
    const top = this.viewerEl.scrollTop + this.viewerEl.clientHeight * 0.32;
    let idx = 0;
    for (let i = 0; i < this.pageEls.length; i++) {
      const el = this.pageEls[i];
      if (el.offsetTop <= top) idx = i;
      else break;
    }
    return idx;
  }

  updateCurrentPage(force = false) {
    if (!this.doc) return;
    const idx = this.currentIndex();
    if (idx === this._lastPage && !force) return;
    this._lastPage = idx;
    this.pageEls.forEach((el, i) => el.classList.toggle('active', i === idx));
    if (this.doc.ui) this.doc.ui.pageIndex = idx;
    this.cb.onPageChange?.(idx + 1, this.doc.numPages);
  }

  onScroll() {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = 0;
      this.updateCurrentPage();
    });
  }

  goToPage(n, { instant = false } = {}) {
    if (!this.doc) return;
    const idx = clamp((n | 0) - 1, 0, this.doc.numPages - 1);
    const el = this.pageEls[idx];
    if (!el) return;
    this.viewerEl.scrollTo({ top: Math.max(0, el.offsetTop - 18), behavior: instant ? 'auto' : 'smooth' });
    this.pageEls.forEach((p, i) => p.classList.toggle('active', i === idx));
    if (this.doc.ui) this.doc.ui.pageIndex = idx;
    this._lastPage = idx;
    this.cb.onPageChange?.(idx + 1, this.doc.numPages);
    setTimeout(() => this.renderPageEl(el), 60);
  }

  async scrollToRect(pageNum, rect) {
    this.goToPage(pageNum, { instant: true });
    const el = this.pageEls[pageNum - 1];
    if (!el) return;
    await new Promise((r) => setTimeout(r, 30));
    this.renderPageEl(el);
    const vp = el._vp || await getPageViewport(this.doc.pdf, pageNum, this.scale, this.viewRotation);
    const r = vp.convertToViewportRectangle(rect);
    const top = el.offsetTop + Math.min(r[1], r[3]) - this.viewerEl.clientHeight * 0.35;
    this.viewerEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  anchor() {
    const idx = this.currentIndex();
    const el = this.pageEls[idx];
    if (!el) return null;
    return { idx, offset: this.viewerEl.scrollTop - el.offsetTop, ratio: this.viewerEl.scrollTop / Math.max(1, this.viewerEl.scrollHeight) };
  }

  restoreAnchor(a) {
    const el = this.pageEls[a.idx];
    if (!el) return;
    this.viewerEl.scrollTop = Math.max(0, el.offsetTop + a.offset * (this.scale / (a.scale || this.scale)));
  }

  /* ── 工具 / 选择 ───────────────────────────────────────── */
  setTool(tool) {
    this.tool = tool;
    this.selectedId = null;
    this.applyToolClass();
    this.renderAnnotations();
  }

  applyToolClass() {
    const b = document.body.classList;
    b.remove('tool-select', 'tool-annot', 'tool-hand', 'tool-draw', 'tool-text');
    if (this.tool === 'hand') b.add('tool-hand');
    else if (DRAW_TOOLS.has(this.tool)) b.add('tool-draw');
    else if (SEL_TOOLS.has(this.tool)) b.add('tool-annot');
    else b.add('tool-select');
  }

  onMouseDown(e) {
    if (this.tool !== 'hand') return;
    this.pan = { x: e.clientX, y: e.clientY, top: this.viewerEl.scrollTop, left: this.viewerEl.scrollLeft };
    this.viewerEl.classList.add('panning');
    const move = (ev) => {
      if (!this.pan) return;
      this.viewerEl.scrollTop = this.pan.top - (ev.clientY - this.pan.y);
      this.viewerEl.scrollLeft = this.pan.left - (ev.clientX - this.pan.x);
    };
    const up = () => {
      this.pan = null;
      this.viewerEl.classList.remove('panning');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  }

  onMouseUp(e) {
    if (this.tool === 'select' && !e.target.closest('.annot')) {
      if (this.selectedId) {
        this.selectedId = null;
        this.applySelection();
      }
    }
    if (!SEL_TOOLS.has(this.tool)) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const items = this.selectionToPdf();
    if (!items.length) return;
    this.cb.onMarkup?.(this.tool, items);
    sel.removeAllRanges();
  }

  selectionToPdf() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    const out = [];
    for (let i = 0; i < this.pageEls.length; i++) {
      const el = this.pageEls[i];
      const pr = el.getBoundingClientRect();
      if (pr.bottom < Math.min(...rects.map((r) => r.top)) - 2000) continue;
      const local = [];
      for (const r of rects) {
        if (r.bottom < pr.top - 1 || r.top > pr.bottom + 1) continue;
        if (r.right < pr.left - 1 || r.left > pr.right + 1) continue;
        const x1 = clamp(r.left - pr.left, 0, pr.width);
        const x2 = clamp(r.right - pr.left, 0, pr.width);
        const y1 = clamp(r.top - pr.top, 0, pr.height);
        const y2 = clamp(r.bottom - pr.top, 0, pr.height);
        if (x2 - x1 < 1 || y2 - y1 < 1) continue;
        const vp = el._vp;
        if (!vp) continue;
        const a = vp.convertToPdfPoint(x1, y1);
        const b = vp.convertToPdfPoint(x2, y2);
        local.push([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
      }
      if (local.length) out.push({ page: i + 1, rects: mergeRects(local) });
    }
    return out;
  }

  /* 只改选中样式，不重建 DOM —— 否则文本框会在点击瞬间失焦，压根没法输入 */
  applySelection() {
    const all = this.pagesEl.querySelectorAll('.annot');
    for (const el of all) {
      const on = el.dataset.id === this.selectedId;
      el.classList.toggle('selected', on);
      let del = null;
      for (const child of el.children) if (child.classList.contains('del')) del = child;
      if (on && !del) {
        el.append(h('button', {
          class: 'del', html: icon('close', 10), title: '删除 (Delete)',
          onclick: (ev) => { ev.stopPropagation(); this.cb.onDeleteAnnot?.(el.dataset.id); },
        }));
      } else if (!on && del) {
        del.remove();
      }
    }
  }

  /* 改字号/宽度后重新量一遍文本框高度，避免保存时被裁 */
  syncTextboxHeights() {
    if (!this.doc) return;
    let changed = false;
    for (const el of this.pagesEl.querySelectorAll('.annot.textbox')) {
      const pageEl = el.closest('.page');
      const vp = pageEl && pageEl._vp;
      const a = this.doc.annots.find((x) => x.id === el.dataset.id);
      if (!a || !vp) continue;
      const hpt = Math.max(12, el.scrollHeight / vp.scale);
      if (Math.abs(hpt - (a.rects[0][3] - a.rects[0][1])) > 0.5) {
        a.rects[0][1] = a.rects[0][3] - hpt;
        changed = true;
      }
    }
    if (changed) this.cb.onAnnotChanged?.();
  }

  /* ── 绘制 ─────────────────────────────────────────────── */
  pageAt(target) {    const el = target.closest ? target.closest('.page') : null;
    return el ? { el, idx: Number(el.dataset.page) } : null;
  }

  localPoint(el, clientX, clientY) {
    const pr = el.getBoundingClientRect();
    return { x: clientX - pr.left, y: clientY - pr.top };
  }

  toPdf(el, x, y) {
    const vp = el._vp;
    if (!vp) return [0, 0];
    return vp.convertToPdfPoint(x, y);
  }

  onPointerDown(e) {
    const hit = this.pageAt(e.target);
    if (!hit) return;
    if (this.tool === 'select') {
      const annotEl = e.target.closest('.annot');
      if (annotEl) {
        if (this.selectedId !== annotEl.dataset.id) {
          this.selectedId = annotEl.dataset.id;
          this.applySelection();
        }
        // 文本框 / 便签 / 图片都能拖动；单击文本框同时把光标放进去，不用再点第二下
        this.startAnnotMove(e, annotEl);
        if (annotEl.dataset.type === 'textbox') annotEl.focus();
        return;
      }
      return;
    }
    if (!DRAW_TOOLS.has(this.tool)) return;
    if (!hit.el._vp) return;
    e.preventDefault();
    const p = this.localPoint(hit.el, e.clientX, e.clientY);
    const pdfPt = this.toPdf(hit.el, p.x, p.y);
    this.startDraw(hit, p, pdfPt, e);
  }

  onPointerMove(e) {
    if (!this.drag) return;
    const d = this.drag;
    if (d.kind === 'annot-move') {
      const pr = d.el.getBoundingClientRect();
      const px = e.clientX - d.startX;
      const py = e.clientY - d.startY;
      d.el.style.transform = `translate(${px}px, ${py}px)`;
      d.dx = px / pr.width;
      d.dy = py / pr.height;
      return;
    }
    const p = this.localPoint(d.pageEl, e.clientX, e.clientY);
    d.cur = p;
    this.updatePreview(d, p);
  }

  onPointerUp(e) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.kind === 'annot-move') {
      this.finishAnnotMove(d);
      return;
    }
    d.preview?.remove();
    const p = this.localPoint(d.pageEl, e.clientX, e.clientY);
    this.finishDraw(d, p, e);
  }

  cancelDrag() {
    if (!this.drag) return;
    this.drag.preview?.remove();
    if (this.drag.previewEl) this.drag.previewEl.style.transform = '';
    this.drag = null;
  }

  startDraw(hit, p, pdfPt, e) {
    const tool = this.tool;
    const page = hit.idx + 1;
    const pageInfo = this.doc.pages[hit.idx];
    const base = { page, color: this.cb.getColor?.() || COLOR_DEFAULT, author: '我', ts: Date.now() };

    if (tool === 'note' || tool === 'freetext' || tool === 'textbox' || tool === 'sign' || tool === 'image') {
      const isText = tool === 'textbox' || tool === 'freetext';
      // 图片/签名按原始宽高比放，不然手写字会被拉扁
      const ratio = isText ? null : (this.cb.getAssetRatio?.() || 2.6);
      const wPt = tool === 'note' ? 18 : isText ? 190 : 132;
      const hPt = tool === 'note' ? 18 : isText ? (this.cb.getFontSize?.() || 12) * 1.7 : Math.max(10, wPt / ratio);
      // 别让框跑到页面外面去
      const pw = pageInfo?.w || 612;
      const ph = pageInfo?.h || 792;
      const x1 = clamp(pdfPt[0], 2, Math.max(2, pw - 24));
      const y2 = clamp(pdfPt[1], 8, ph - 4);
      const x2 = Math.min(x1 + wPt, pw - 4);
      const y1 = Math.max(2, y2 - hPt);
      this.cb.onCreateAnnot?.({
        ...base,
        type: isText ? 'textbox' : tool,
        rects: [[x1, y1, x2, y2]],
        content: '',
        fontSize: this.cb.getFontSize?.() || 12,
        erase: isText ? this.cb.getErase?.() !== false : false,
        dataUrl: tool === 'sign' ? this.cb.getSignature?.() : tool === 'image' ? this.cb.getImage?.() : null,
        redact: false,
      });
      return;
    }

    const preview = document.createElement('div');
    preview.className = 'draw-preview';
    preview.style.cssText = `position:absolute;left:${p.x}px;top:${p.y}px;pointer-events:none;z-index:9;${tool === 'redact' ? 'background:rgba(215,55,63,.35);border:1px solid #d7373f;' : 'border:1.5px dashed #1473e6;'}`;
    hit.el.append(preview);

    this.drag = {
      kind: 'draw', tool, pageEl: hit.el, idx: hit.idx, start: p, cur: p, startPt: pdfPt,
      color: base.color, preview, pageInfo, page,
    };
    if (tool === 'ink') {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ink-preview');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:9';
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', base.color);
      path.setAttribute('stroke-width', '2');
      svg.append(path);
      hit.el.append(svg);
      preview.remove();
      this.drag.svg = svg;
      this.drag.path = path;
      this.drag.points = [p];
    }
  }

  updatePreview(d, p) {
    if (d.tool === 'ink') {
      d.points.push(p);
      const dpath = d.points.map((pt, i) => (i ? 'L' : 'M') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1)).join(' ');
      d.path.setAttribute('d', dpath);
      return;
    }
    const x = Math.min(d.start.x, p.x), y = Math.min(d.start.y, p.y);
    const w = Math.abs(p.x - d.start.x), hh = Math.abs(p.y - d.start.y);
    d.preview.style.left = x + 'px';
    d.preview.style.top = y + 'px';
    d.preview.style.width = w + 'px';
    d.preview.style.height = hh + 'px';
  }

  finishDraw(d, p, e) {
    const base = { page: d.page, color: d.color, author: '我', ts: Date.now() };
    if (d.tool === 'ink') {
      d.svg?.remove();
      if (!d.points || d.points.length < 2) return;
      const pts = d.points.map((pt) => {
        const pdf = this.toPdf(d.pageEl, pt.x, pt.y);
        return [pdf[0], pdf[1]];
      });
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      this.cb.onCreateAnnot?.({
        ...base, type: 'ink', points: pts, strokeWidth: 2,
        rects: [[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]],
      });
      return;
    }
    const a = this.toPdf(d.pageEl, d.start.x, d.start.y);
    const b = this.toPdf(d.pageEl, p.x, p.y);
    const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) {
      rect[2] = rect[0] + 60;
      rect[3] = rect[1] + 24;
    }
    if (d.tool === 'redact') this.cb.onRedact?.(rect, d.page);
    else if (d.tool === 'rect') this.cb.onCreateAnnot?.({ ...base, type: 'rect', rects: [rect], strokeWidth: 2 });
    else if (d.tool === 'arrow') this.cb.onCreateAnnot?.({ ...base, type: 'arrow', rects: [rect], points: [a, b], strokeWidth: 2 });
  }

  startAnnotMove(e, annotEl) {
    const a = this.doc.annots.find((x) => x.id === annotEl.dataset.id);
    // 手绘/箭头/图形不支持拖动；已经写进文件的也不再挪（字节里已有它）
    if (!a || a.inFile || !['note', 'textbox', 'image', 'sign'].includes(a.type)) return;
    this.drag = {
      kind: 'annot-move', id: a.id, el: annotEl, startX: e.clientX, startY: e.clientY,
      orig: a.rects[0].slice(), pageEl: annotEl.closest('.page'), dx: 0, dy: 0,
    };
    annotEl.setPointerCapture?.(e.pointerId);
  }

  /* 用方向键微调位置：1pt，按住 Shift 是 10pt */
  nudge(id, dx, dy) {
    const a = this.doc?.annots.find((x) => x.id === id);
    if (!a || a.inFile || !['note', 'textbox', 'image', 'sign', 'rect'].includes(a.type)) return;
    a.rects = a.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
    if (a.points) a.points = a.points.map((p) => [p[0] + dx, p[1] + dy]);
    this.cb.onAnnotChanged?.(a.id);
    this.renderAnnotations();
  }

  finishAnnotMove(d) {
    d.el.style.transform = '';
    const a = this.doc.annots.find((x) => x.id === d.id);
    if (!a) return;
    const pr = this.pageEls[a.page - 1].getBoundingClientRect();
    const ddx = d.dx * (a.rects[0][2] - a.rects[0][0]);
    const ddy = -d.dy * (a.rects[0][3] - a.rects[0][1]);
    if (Math.abs(ddx) < 0.5 && Math.abs(ddy) < 0.5) return;
    a.rects[0] = [d.orig[0] + ddx, d.orig[1] + ddy, d.orig[2] + ddx, d.orig[3] + ddy];
    if (a.points) a.points = a.points.map((p) => [p[0] + ddx, p[1] + ddy]);
    this.cb.onAnnotChanged?.(a.id);
    this.renderAnnotations();
  }

  /* ── 注释渲染 ─────────────────────────────────────────── */
  renderAnnotations() {
    if (!this.doc) return;
    for (let i = 0; i < this.pageEls.length; i++) this.renderAnnotationsFor(i);
  }

  renderAnnotationsFor(idx) {
    const el = this.pageEls[idx];
    if (!el) return;
    const layer = el.querySelector('.annot-layer');
    if (!layer) return;
    const vp = el._vp;
    if (!vp) return;
    const page = idx + 1;
    layer.replaceChildren();
    const list = this.doc.annots.filter((a) => a.page === page && !a.inFile);
    const svgNeeded = list.some((a) => a.type === 'ink' || a.type === 'arrow');
    let svg = null;
    if (svgNeeded) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.style.cssText = 'position:absolute;inset:0;overflow:visible;pointer-events:none';
      layer.append(svg);
    }
    for (const a of list) layer.append(this.annotEl(a, vp, svg));
    const reds = (this.doc.redacts || []).filter((r) => r.page === page);
    for (const r of reds) {
      const rr = vp.convertToViewportRectangle(r.rect);
      const d = h('div', { class: 'annot', style: { position: 'absolute', background: 'rgba(215,55,63,.28)', border: '1px solid #d7373f', pointerEvents: 'none' } });
      d.style.left = Math.min(rr[0], rr[2]) + 'px';
      d.style.top = Math.min(rr[1], rr[3]) + 'px';
      d.style.width = Math.abs(rr[2] - rr[0]) + 'px';
      d.style.height = Math.abs(rr[3] - rr[1]) + 'px';
      layer.append(d);
    }
  }

  annotEl(a, vp, svg) {
    const r = vp.convertToViewportRectangle(a.rects[0]);
    const left = Math.min(r[0], r[2]), top = Math.min(r[1], r[3]);
    const w = Math.abs(r[2] - r[0]), hh = Math.abs(r[3] - r[1]);
    const color = a.color || COLOR_DEFAULT;
    let el;
    if (a.type === 'highlight') {
      el = h('div', { class: 'annot hl', style: { left: left + 'px', top: top + 'px', width: w + 'px', height: hh + 'px', background: hexA(color, .38) } });
      if (a.rects.length > 1) {
        el = h('div', { class: 'annot hl', style: { left: '0', top: '0', width: '100%', height: '100%', background: 'transparent', pointerEvents: 'none' } });
        a.rects.forEach((rect) => {
          const q = vp.convertToViewportRectangle(rect);
          el.append(h('div', { style: { position: 'absolute', left: Math.min(q[0], q[2]) + 'px', top: Math.min(q[1], q[3]) + 'px', width: Math.abs(q[2] - q[0]) + 'px', height: Math.abs(q[3] - q[1]) + 'px', background: hexA(color, .38) } }));
        });
      }
    } else if (a.type === 'underline') {
      el = h('div', { class: 'annot ul', style: { left: left + 'px', top: top + 'px', width: w + 'px', height: hh + 'px', borderColor: color } });
    } else if (a.type === 'strikeout') {
      el = h('div', { class: 'annot strike', style: { left: left + 'px', top: top + 'px', width: w + 'px', height: hh + 'px', color } });
    } else if (a.type === 'note') {
      el = h('div', { class: 'annot note', title: a.content || '便签', html: icon('comment', 14), style: { left: left + 'px', top: top + 'px', background: color } });
    } else if (a.type === 'rect') {
      el = h('div', { class: 'annot box', style: { left: left + 'px', top: top + 'px', width: w + 'px', height: hh + 'px', borderColor: color } });
    } else if (a.type === 'textbox') {
      const fsPx = (a.fontSize || 12) * vp.scale;
      el = h('div', {
        class: 'annot textbox',
        contenteditable: 'true',
        spellcheck: 'false',
        style: {
          left: left + 'px', top: top + 'px',
          width: Math.max(40, w) + 'px',
          minHeight: Math.max(16, hh) + 'px',
          fontSize: fsPx.toFixed(2) + 'px',
          lineHeight: '1.32',
          padding: (2 * vp.scale).toFixed(2) + 'px',
          boxSizing: 'border-box',
          background: a.erase ? '#ffffff' : 'rgba(255,255,255,.72)',
        },
      });
      el.textContent = a.content || '';
      const readText = () => readEditable(el);
      const syncHeight = () => {
        // 文字变多就往下长，重新算 PDF 矩形，否则保存时会被裁掉
        const hpt = Math.max(12, el.scrollHeight / vp.scale);
        if (Math.abs(hpt - (a.rects[0][3] - a.rects[0][1])) > 0.5) {
          a.rects[0][1] = a.rects[0][3] - hpt;
          this.cb.onAnnotChanged?.(a.id);
        }
      };
      el.addEventListener('input', () => { this.cb.onTextEdit?.(a.id, readText()); syncHeight(); });
      el.addEventListener('blur', () => {
        if (!readText().trim()) this.cb.onDeleteAnnot?.(a.id);
        else syncHeight();
      });
      // 还拿着「文本框」工具时，点已有的框只是继续输入，不要再叠一个新的
      el.addEventListener('pointerdown', (e) => { if (this.tool !== 'select') e.stopPropagation(); });
      el.addEventListener('dblclick', (e) => { e.stopPropagation(); el.focus(); });
    } else if (a.type === 'image' || a.type === 'sign') {
      el = h('img', { class: 'annot img', src: a.dataUrl, style: { left: left + 'px', top: top + 'px', width: w + 'px', height: hh + 'px' } });
    } else if (a.type === 'ink') {
      el = h('div', { class: 'annot ink', style: { left: left + 'px', top: top + 'px', width: Math.max(2, w) + 'px', height: Math.max(2, hh) + 'px', pointerEvents: 'none' } });
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const d = (a.points || []).map((pt, i) => {
        const q = vp.convertToViewportPoint(pt[0], pt[1]);
        return (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1);
      }).join(' ');
      path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', color);
      path.setAttribute('stroke-width', String(a.strokeWidth || 2));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      path.style.pointerEvents = 'visibleStroke';
      path.style.pointerEvents = 'stroke';
      path.setAttribute('cursor', 'pointer');
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      hit.setAttribute('d', d);
      hit.setAttribute('fill', 'none');
      hit.setAttribute('stroke', 'transparent');
      hit.setAttribute('stroke-width', '12');
      hit.style.pointerEvents = 'stroke';
      hit.style.cursor = 'pointer';
      hit.dataset.id = a.id;
      hit.dataset.type = 'ink';
      el.append(path);
      return el;
    } else if (a.type === 'arrow') {
      el = h('div', { class: 'annot arrow', style: { left: left + 'px', top: top + 'px', width: Math.max(2, w) + 'px', height: Math.max(2, hh) + 'px', pointerEvents: 'none' } });
      const p1 = vp.convertToViewportPoint(a.points[0][0], a.points[0][1]);
      const p2 = vp.convertToViewportPoint(a.points[1][0], a.points[1][1]);
      const ns = 'http://www.w3.org/2000/svg';
      const svg2 = document.createElementNS(ns, 'svg');
      svg2.style.cssText = 'position:absolute;inset:0;overflow:visible';
      const line = document.createElementNS(ns, 'path');
      line.setAttribute('d', `M${p1[0]} ${p1[1]} L${p2[0]} ${p2[1]}`);
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', String(a.strokeWidth || 2));
      line.setAttribute('fill', 'none');
      line.setAttribute('marker-end', `url(#arw-${a.id})`);
      const defs = document.createElementNS(ns, 'defs');
      const marker = document.createElementNS(ns, 'marker');
      marker.setAttribute('id', `arw-${a.id}`);
      marker.setAttribute('markerWidth', '8');
      marker.setAttribute('markerHeight', '8');
      marker.setAttribute('refX', '6');
      marker.setAttribute('refY', '3');
      marker.setAttribute('orient', 'auto');
      const tip = document.createElementNS(ns, 'path');
      tip.setAttribute('d', 'M0,0 L6,3 L0,6 Z');
      tip.setAttribute('fill', color);
      marker.append(tip);
      defs.append(marker);
      svg2.append(defs, line);
      el.append(svg2);
      return el;
    } else {
      el = h('div', { class: 'annot', style: { left: left + 'px', top: top + 'px', width: w + 'px', height: hh + 'px' } });
    }
    el.dataset.id = a.id;
    el.dataset.type = a.type;
    el.classList.toggle('selected', this.selectedId === a.id);
    if (this.selectedId === a.id) {
      el.append(h('button', { class: 'del', html: icon('close', 10), title: '删除注释', onclick: (ev) => { ev.stopPropagation(); this.cb.onDeleteAnnot?.(a.id); } }));
    }
    return el;
  }

  /* ── 表单 ─────────────────────────────────────────────── */
  async buildFormLayer(idx, vp) {
    const el = this.pageEls[idx];
    if (!el || !this.doc) return;
    const layer = el.querySelector('.form-layer');
    layer.replaceChildren();
    const widgets = await getWidgets(this.doc.pdf, idx + 1);
    const fieldValues = this.doc.fields || {};
    const seen = new Set();
    for (const w of widgets) {
      if (!w.fieldName) continue;
      const key = w.fieldName;
      if (seen.has(key + (w.id || ''))) continue;
      seen.add(key + (w.id || ''));
      const rr = vp.convertToViewportRectangle(w.rect);
      const left = Math.min(rr[0], rr[2]), top = Math.min(rr[1], rr[3]);
      const width = Math.max(6, Math.abs(rr[2] - rr[0])), height = Math.max(6, Math.abs(rr[3] - rr[1]));
      let inp;
      const val = fieldValues[key] !== undefined ? fieldValues[key] : (w.fieldValue ?? '');
      if (w.fieldType === 'Tx') {
        inp = h('input', { type: 'text', value: val, style: { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' } });
        if (w.multiLine) {
          inp = h('textarea', { style: { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' } });
          inp.value = val;
        }
        inp.addEventListener('change', () => this.cb.onField?.(key, inp.value));
      } else if (w.fieldType === 'Btn' && w.checkBox) {
        inp = h('input', { type: 'checkbox', style: { left: left + 'px', top: top + 'px', width: Math.min(18, width) + 'px', height: Math.min(18, height) + 'px' } });
        inp.checked = !!(fieldValues[key] ?? w.fieldValue);
        inp.addEventListener('change', () => this.cb.onField?.(key, inp.checked));
      } else if (w.fieldType === 'Btn' && w.radioButton) {
        inp = h('input', { type: 'radio', name: key, value: w.buttonValue || '', style: { left: left + 'px', top: top + 'px', width: Math.min(18, width) + 'px', height: Math.min(18, height) + 'px' } });
        inp.checked = (fieldValues[key] ?? w.fieldValue) === (w.buttonValue || '');
        inp.addEventListener('change', () => this.cb.onField?.(key, w.buttonValue));
      } else if (w.fieldType === 'Ch') {
        inp = h('select', { style: { left: left + 'px', top: top + 'px', width: width + 'px', height: height + 'px' } });
        const opts = w.options || [];
        inp.append(h('option', { value: '', text: '—' }));
        for (const o of opts) inp.append(h('option', { value: o.exportValue || o.displayValue, text: o.displayValue }));
        inp.value = fieldValues[key] ?? w.fieldValue ?? '';
        inp.addEventListener('change', () => this.cb.onField?.(key, inp.value));
      } else {
        continue;
      }
      inp.dataset.field = key;
      layer.append(inp);
    }
  }

  /* ── 搜索高亮 ─────────────────────────────────────────── */
  renderSearchHits() {
    for (let i = 0; i < this.pageEls.length; i++) this.renderSearchHitsFor(i);
  }

  renderSearchHitsFor(idx) {
    const el = this.pageEls[idx];
    if (!el) return;
    const layer = el.querySelector('.search-hits');
    if (!layer) return;
    layer.replaceChildren();
    const vp = el._vp;
    const hits = (this.doc?.searchHits || []).filter((s) => s.page === idx + 1);
    if (!vp || !hits.length) return;
    for (const hit of hits) {
      for (const rect of hit.rects) {
        const r = vp.convertToViewportRectangle(rect);
        const d = h('i', { class: hit.index === this.doc.currentHit ? 'cur' : '' });
        d.style.left = Math.min(r[0], r[2]) + 'px';
        d.style.top = Math.min(r[1], r[3]) + 'px';
        d.style.width = Math.abs(r[2] - r[0]) + 'px';
        d.style.height = Math.abs(r[3] - r[1]) + 'px';
        layer.append(d);
      }
    }
  }

  /* ── 缩略图 ───────────────────────────────────────────── */
  async renderThumb(pageNum, canvas, width = 116) {
    if (!this.doc) return;
    const page = await this.doc.pdf.getPage(pageNum);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = width / vp0.width;
    const vp = page.getViewport({ scale });
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp, background: '#fff', annotationMode: 1 }).promise;
  }
}

/** contenteditable 里按回车会生成 <div>/<br>，直接取 textContent 会把换行吃掉 */
function readEditable(root) {
  let out = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.nodeName === 'BR') out += '\n';
      else if (c.nodeName === 'DIV' || c.nodeName === 'P') {
        if (out && !out.endsWith('\n')) out += '\n';
        walk(c);
      } else {
        walk(c);
      }
    }
  };
  walk(root);
  return out.replace(/\n$/, '');
}

function hexA(hex, alpha) {  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(255,225,77,${alpha})`;
  const v = parseInt(m[1], 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${alpha})`;
}

/** 合并同一行相邻矩形，减少注释碎片 */
function mergeRects(rects) {
  const sorted = rects.slice().sort((a, b) => (Math.abs(a[1] - b[1]) > 2 ? b[1] - a[1] : a[0] - b[0]));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - r[1]) < 1.5 && Math.abs(last[3] - r[3]) < 1.5 && r[0] - last[2] < 6) {
      last[2] = Math.max(last[2], r[2]);
      last[1] = Math.min(last[1], r[1]);
      last[3] = Math.max(last[3], r[3]);
    } else {
      out.push(r.slice());
    }
  }
  return out;
}
