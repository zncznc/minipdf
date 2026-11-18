/* PDF 写操作：全部经 pdf-lib 落到真实文件 */
const L = window.PDFLib;
const { PDFDocument, degrees, rgb, PDFName, PDFHexString, PDFString, PDFArray, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = L;

const AUTHOR = 'MiniPDF';

function dateStr(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}+08'00'`;
}

function colorArr(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const v = m ? parseInt(m[1], 16) : 0xffe14d;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

async function loadDoc(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
}

function annotDict(pdfDoc, page, a) {
  const ctx = pdfDoc.context;
  const rect = a.rects[0];
  const common = {
    Type: 'Annot',
    Rect: [rect[0], rect[1], rect[2], rect[3]],
    F: 4,
    T: PDFHexString.fromText(a.author || AUTHOR),
    M: PDFString.of(dateStr(new Date(a.ts || Date.now()))),
    P: page.ref,
    NM: PDFString.of(a.id || 'minipdf'),
  };
  const contents = { Contents: PDFHexString.fromText(a.content || '') };
  let dict = null;
  if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strikeout') {
    const sub = a.type === 'highlight' ? 'Highlight' : a.type === 'underline' ? 'Underline' : 'StrikeOut';
    const quads = [];
    for (const q of a.rects) quads.push(q[0], q[3], q[2], q[3], q[0], q[1], q[2], q[1]);
    dict = ctx.obj({ ...common, Subtype: sub, C: colorArr(a.color), CA: 0.42, QuadPoints: quads, ...contents });
  } else if (a.type === 'note') {
    dict = ctx.obj({ ...common, Subtype: 'Text', Name: 'Comment', C: colorArr(a.color), Open: false, ...contents });
  } else if (a.type === 'rect') {
    dict = ctx.obj({ ...common, Subtype: 'Square', C: colorArr(a.color), BS: { W: a.strokeWidth || 2, S: 'S' }, ...contents });
  } else if (a.type === 'ink') {
    dict = ctx.obj({
      ...common, Subtype: 'Ink', C: colorArr(a.color),
      BS: { W: a.strokeWidth || 2, S: 'S' },
      InkList: [a.points.flatMap((p) => [p[0], p[1]])],
    });
  } else if (a.type === 'arrow') {
    dict = ctx.obj({
      ...common, Subtype: 'Line', C: colorArr(a.color),
      L: [a.points[0][0], a.points[0][1], a.points[1][0], a.points[1][1]],
      LE: [PDFName.of('None'), PDFName.of('OpenArrow')],
      BS: { W: a.strokeWidth || 2, S: 'S' },
    });
  }
  return dict;
}

function applyAnnots(pdfDoc, annots) {
  const ctx = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const byPage = new Map();
  for (const a of annots) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const dict = annotDict(pdfDoc, page, a);
    if (!dict) continue;
    const ref = ctx.register(dict);
    if (!byPage.has(a.page - 1)) byPage.set(a.page - 1, []);
    byPage.get(a.page - 1).push(ref);
  }
  for (const [pi, refs] of byPage) {
    const page = pages[pi];
    let arr = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!arr) {
      arr = PDFArray.withContext(ctx);
      page.node.set(PDFName.of('Annots'), arr);
    }
    for (const r of refs) arr.push(r);
  }
}

/** 删除 MiniPDF 自己写入的注释（按 /NM 匹配） */
function removeAnnots(pdfDoc, removed) {
  if (!removed || !removed.length) return;
  const ctx = pdfDoc.context;
  const pages = pdfDoc.getPages();
  for (const item of removed) {
    const page = pages[item.page - 1];
    if (!page) continue;
    const arr = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!arr) continue;
    const keep = PDFArray.withContext(ctx);
    for (let i = 0; i < arr.size(); i++) {
      const ref = arr.get(i);
      const dict = ctx.lookup(ref);
      const nmObj = dict && dict.get ? dict.get(PDFName.of('NM')) : null;
      let nm = '';
      try { nm = nmObj && nmObj.decodeText ? nmObj.decodeText() : String(nmObj || ''); } catch { nm = ''; }
      if (nm && nm === item.nm) continue;
      keep.push(ref);
    }
    page.node.set(PDFName.of('Annots'), keep);
  }
}

/** 把 canvas 里的文字/图片按 PDF 坐标贴到页面上（真正写进内容流） */
async function drawRaster(pdfDoc, page, dataUrl, rect, opts = {}) {
  let bytes = dataUrlBytes(dataUrl);
  const isJpg = /^data:image\/jpe?g/.test(dataUrl);
  const img = isJpg ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
  const width = rect[2] - rect[0];
  const height = rect[3] - rect[1];
  page.drawImage(img, { x: rect[0], y: rect[1], width, height, opacity: opts.opacity ?? 1 });
}

function dataUrlBytes(url) {
  const b64 = String(url).split(',')[1] || '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ────────────────────────────────────────────────────────────
   文字排版内核
   预览和写入共用这一套，保证「看到的」就是「存进去的」
   ──────────────────────────────────────────────────────────── */
export const TEXT_STYLE_DEFAULT = Object.freeze({
  font: 'Microsoft YaHei',
  fontSize: 12,
  color: '#111111',
  bold: false,
  italic: false,
  underline: false,
  script: 'none',      // none | sup | sub
  align: 'left',       // left | center | right | justify
  lineSpacing: 1.32,
  paraSpacing: 0,
  charSpacing: 0,
  hScale: 100,         // 水平缩放 %
  list: 'none',        // none | bullet | number
  opacity: 1,
  rotate: 0,
  flipH: false,
  flipV: false,
});

/* Acrobat「编辑 PDF → 格式」里的字体下拉，对应本机可用的同名字体 */
export const FONT_CHOICES = [
  ['Microsoft YaHei', '微软雅黑'],
  ['SimSun', '宋体'],
  ['SimHei', '黑体'],
  ['KaiTi', '楷体'],
  ['FangSong', '仿宋'],
  ['DengXian', '等线'],
  ['Arial', 'Arial'],
  ['Times New Roman', 'Times New Roman'],
  ['Calibri', 'Calibri'],
  ['Georgia', 'Georgia'],
  ['Courier New', 'Courier New'],
];

let _measure = null;
function measureCtx() {
  if (!_measure) {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    _measure = c.getContext('2d');
  }
  return _measure;
}

function familyOf(a) {
  return `"${a.font || 'Microsoft YaHei'}", "Microsoft YaHei", "Segoe UI", sans-serif`;
}

function fontCss(a, size) {
  const weight = a.bold ? '700' : '400';
  const style = a.italic ? 'italic' : 'normal';
  return `${style} ${weight} ${size}px ${familyOf(a)}`;
}

function nominalSize(a) { return Math.max(1, Number(a.fontSize) || 12); }
function scriptScale(a) { return a.script === 'sup' || a.script === 'sub' ? 0.62 : 1; }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/**
 * 排版：折行、每行宽度、行高、段间距。
 * 单位统一用 PDF 点（1pt = 1px 的画布坐标）。
 */
export function textBoxLines(a, widthPt) {
  const fs = nominalSize(a);
  const size = fs * scriptScale(a);
  const hs = Math.max(10, num(a.hScale, 100)) / 100;
  const cs = num(a.charSpacing, 0);
  const pad = 2;
  const maxW = Math.max(8, widthPt - pad * 2);
  const ctx = measureCtx();
  ctx.font = fontCss(a, size);
  const charW = (ch) => ctx.measureText(ch).width * hs + cs;

  const paras = String(a.content == null ? '' : a.content).split('\n');
  const lines = [];
  paras.forEach((para, pi) => {
    let text = para;
    if (a.list === 'bullet') text = '• ' + para;
    else if (a.list === 'number') text = (pi + 1) + '. ' + para;
    if (!text) { lines.push({ text: '', w: 0, para: pi, last: true }); return; }
    let cur = '';
    let curW = 0;
    for (const ch of text) {
      const cw = charW(ch);
      if (cur && curW + cw > maxW) {
        lines.push({ text: cur, w: curW, para: pi, last: false });
        cur = ch; curW = cw;
      } else { cur += ch; curW += cw; }
    }
    if (cur) lines.push({ text: cur, w: curW, para: pi, last: true });
  });
  return {
    lines, fs, size, pad, maxW, hs, cs,
    lineH: fs * Math.max(0.5, num(a.lineSpacing, 1.32)),
    paraSpacing: Math.max(0, num(a.paraSpacing, 0)),
  };
}

/** 文本块自然高度（pt）：段落数决定段间距，行数决定行高 */
export function textBoxHeight(a, widthPt) {
  const lay = textBoxLines(a, widthPt);
  const paras = new Set(lay.lines.map((l) => l.para)).size;
  return lay.pad * 2 + lay.lines.length * lay.lineH + Math.max(0, paras - 1) * lay.paraSpacing;
}

function drawLines(ctx, a, lay, widthPt) {
  const { lines, fs, size, pad, maxW, lineH, paraSpacing } = lay;
  ctx.font = fontCss(a, size);
  ctx.fillStyle = a.color || '#111111';
  ctx.globalAlpha = Math.max(0, Math.min(1, num(a.opacity, 1)));
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const lift = a.script === 'sup' ? -fs * 0.36 : a.script === 'sub' ? fs * 0.18 : 0;
  let y = pad;
  let prev = lines.length ? lines[0].para : 0;
  for (const ln of lines) {
    if (ln.para !== prev) { y += paraSpacing; prev = ln.para; }
    const baseline = y + fs * 0.8 + lift;
    let extra = 0;
    if (a.align === 'justify' && !ln.last && ln.text.length > 1) {
      extra = Math.max(0, (maxW - ln.w) / (ln.text.length - 1));
    }
    const lineW = ln.w + extra * Math.max(0, ln.text.length - 1);
    let x = pad;
    if (a.align === 'center') x = pad + (maxW - lineW) / 2;
    else if (a.align === 'right') x = pad + (maxW - lineW);
    const startX = x;
    for (const ch of ln.text) {
      const cw = ctx.measureText(ch).width;
      if (ch !== ' ') {
        if (Math.abs(lay.hs - 1) > 1e-3) {
          ctx.save();
          ctx.translate(x, baseline);
          ctx.scale(lay.hs, 1);
          ctx.fillText(ch, 0, 0);
          ctx.restore();
        } else {
          ctx.fillText(ch, x, baseline);
        }
      }
      x += cw * lay.hs + lay.cs + extra;
    }
    if (a.underline && ln.text.trim()) {
      ctx.fillRect(startX, baseline + fs * 0.16, Math.max(1, lineW), Math.max(0.6, fs * 0.055));
    }
    y += lineH;
  }
  ctx.globalAlpha = 1;
}

/**
 * 文本块 → canvas。预览和保存都走这里。
 * rotate / flipH / flipV 作用在整块字上，边框不变。
 */
export function renderTextBox(a, widthPt, heightPt, scale = 3) {
  const W = Math.max(8, widthPt);
  const H = Math.max(8, heightPt);
  const rot = ((Math.round(num(a.rotate, 0)) % 360) + 360) % 360;
  // 转 90/270 时按「换过来」的尺寸排版，转回去正好铺满整框，字不会被压扁
  const swap = rot === 90 || rot === 270;
  const layW = swap ? H : W;
  const layH = swap ? W : H;

  const src = document.createElement('canvas');
  src.width = Math.max(1, Math.round(layW * scale));
  src.height = Math.max(1, Math.round(layH * scale));
  const ctx = src.getContext('2d');
  ctx.scale(scale, scale);
  drawLines(ctx, a, textBoxLines(a, layW), layW);

  if (!rot && !a.flipH && !a.flipV) {
    src._scale = scale;
    return src;
  }

  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(W * scale));
  out.height = Math.max(1, Math.round(H * scale));
  const octx = out.getContext('2d');
  octx.save();
  octx.translate(out.width / 2, out.height / 2);
  if (rot) octx.rotate((rot * Math.PI) / 180);
  octx.scale(a.flipH ? -1 : 1, a.flipV ? -1 : 1);
  octx.drawImage(src, -src.width / 2, -src.height / 2);
  octx.restore();
  return out;
}

/** 文本框 → 位图（避免 CJK 字体嵌入问题，保证所见即所得） */
export function textboxToPng(a, scale = 3) {
  const rect = a.rects[0];
  const w = Math.max(24, rect[2] - rect[0]);
  const hh = Math.max(14, rect[3] - rect[1]);
  return renderTextBox(a, w, hh, scale).toDataURL('image/png');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** 图片/签名的翻转、旋转：先转成位图再嵌入，不依赖 pdf-lib 的变换原点 */
export async function transformRaster(dataUrl, opts = {}) {
  const rot = ((Math.round(num(opts.rotate, 0)) % 360) + 360) % 360;
  if (!rot && !opts.flipH && !opts.flipV) return dataUrl;
  const img = await loadImage(dataUrl);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth || img.width;
  c.height = img.naturalHeight || img.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  const f = rot === 90 || rot === 270 ? Math.min(c.width / c.height, c.height / c.width) : 1;
  ctx.scale((opts.flipH ? -1 : 1) * f, (opts.flipV ? -1 : 1) * f);
  ctx.drawImage(img, -c.width / 2, -c.height / 2);
  return c.toDataURL('image/png');
}

/**
 * 裁剪位图：按四边裁掉的百分比（0~0.9）切一块出来。
 * 返回新的 dataURL 和宽高比，调用方按新比例改矩形，避免拉扁。
 */
export async function cropRaster(dataUrl, frac = {}) {
  const img = await loadImage(dataUrl);
  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const f = (v) => Math.min(0.9, Math.max(0, num(v, 0)));
  const l = f(frac.l), r = f(frac.r), t = f(frac.t), b = f(frac.b);
  const sx = Math.round(W * l);
  const sy = Math.round(H * t);
  const sw = Math.max(1, Math.round(W * (1 - Math.min(0.98, l + r))));
  const sh = Math.max(1, Math.round(H * (1 - Math.min(0.98, t + b))));
  const c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return { dataUrl: c.toDataURL('image/png'), ratio: sw / sh, w: sw, h: sh };
}

/**
 * 生成待保存的字节。
 * @param {Uint8Array} bytes 原始文件
 * @param {Array} annots 应用层注释
 * @param {Object} fields 表单字段值
 */
export async function savePdf(bytes, annots = [], fields = {}, opts = {}) {
  const pdfDoc = await loadDoc(bytes);
  const pages = pdfDoc.getPages();

  removeAnnots(pdfDoc, opts.removed);

  const vectorAnnots = [];
  for (const a of annots) {
    if (!pages[a.page - 1]) continue;
    if (a.type === 'textbox' || a.type === 'image' || a.type === 'sign') {
      let dataUrl = null;
      if (a.type === 'textbox') dataUrl = textboxToPng(a, 3);
      else dataUrl = await transformRaster(a.dataUrl, a);
      if (dataUrl) {
        // 文本框默认先在底下铺一层白，盖住被替换的原文；否则新旧文字叠在一起没法看
        if (a.type === 'textbox' && a.erase !== false) {
          const r = a.rects[0];
          pages[a.page - 1].drawRectangle({
            x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1],
            color: rgb(1, 1, 1), opacity: num(a.opacity, 1) < 1 ? num(a.opacity, 1) : 1,
          });
        }
        await drawRaster(pdfDoc, pages[a.page - 1], dataUrl, a.rects[0]);
      }
      continue;
    }
    vectorAnnots.push(a);
  }
  applyAnnots(pdfDoc, vectorAnnots);

  if (fields && Object.keys(fields).length) {
    const form = pdfDoc.getForm();
    for (const [name, val] of Object.entries(fields)) {
      try {
        const f = form.getField(name);
        if (!f) continue;
        if (f instanceof PDFTextField) f.setText(val == null ? '' : String(val));
        else if (f instanceof PDFCheckBox) (val ? f.check() : f.uncheck());
        else if (f instanceof PDFRadioGroup) { if (val) f.select(String(val)); }
        else if (f instanceof PDFDropdown) { if (val) f.select(String(val)); }
        else if (f instanceof PDFOptionList) { if (val) f.select(String(val)); }
        else console.warn('unsupported field type', name);
      } catch { /* 字段类型不支持时跳过，不让整份保存失败 */ }
    }
    try { form.updateFieldAppearances(); } catch { /* 某些字体缺失时忽略 */ }
  }

  if (opts.title) pdfDoc.setTitle(opts.title, { showInWindowTitleBar: false });
  pdfDoc.setModificationDate(new Date());
  return pdfDoc.save({ useObjectStreams: true });
}

export async function rotatePages(bytes, indices, delta) {
  const pdfDoc = await loadDoc(bytes);
  const pages = pdfDoc.getPages();
  for (const i of indices) {
    const page = pages[i];
    if (!page) continue;
    const cur = page.getRotation().angle || 0;
    page.setRotation(degrees(((cur + delta) % 360 + 360) % 360));
  }
  return pdfDoc.save();
}

export async function deletePages(bytes, indices) {
  const pdfDoc = await loadDoc(bytes);
  [...indices].sort((a, b) => b - a).forEach((i) => {
    if (i >= 0 && i < pdfDoc.getPageCount()) pdfDoc.removePage(i);
  });
  if (pdfDoc.getPageCount() === 0) throw new Error('不能删除全部页面');
  return pdfDoc.save();
}

export async function movePage(bytes, from, to) {
  const src = await loadDoc(bytes);
  const n = src.getPageCount();
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return null;
  const order = [...Array(n).keys()];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, order);
  copied.forEach((p) => out.addPage(p));
  copyMeta(src, out);
  return out.save();
}

function copyMeta(src, out) {
  try {
    const t = src.getTitle();
    if (t) out.setTitle(t);
    const a = src.getAuthor();
    if (a) out.setAuthor(a);
    const s = src.getSubject();
    if (s) out.setSubject(s);
  } catch { /* 元数据缺失不影响 */ }
}

export async function insertPages(bytes, otherBytes, indices, at) {
  const base = await loadDoc(bytes);
  const other = await loadDoc(otherBytes);
  const total = other.getPageCount();
  const picks = indices && indices.length ? indices : [...Array(total).keys()];
  const copied = await base.copyPages(other, picks.filter((i) => i >= 0 && i < total));
  const pos = Math.max(0, Math.min(at, base.getPageCount()));
  copied.forEach((p, k) => base.insertPage(pos + k, p));
  return base.save();
}

export async function extractPages(bytes, indices) {
  const src = await loadDoc(bytes);
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, indices);
  copied.forEach((p) => out.addPage(p));
  copyMeta(src, out);
  return out.save();
}

export async function splitEvery(bytes, chunk) {
  const src = await loadDoc(bytes);
  const n = src.getPageCount();
  const results = [];
  for (let start = 0; start < n; start += chunk) {
    const idx = [];
    for (let i = start; i < Math.min(n, start + chunk); i++) idx.push(i);
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, idx);
    copied.forEach((p) => out.addPage(p));
    copyMeta(src, out);
    results.push({ from: start + 1, to: idx[idx.length - 1] + 1, bytes: await out.save() });
  }
  return results;
}

/** 逐页栅格化重建：压缩 / 真修订 / 统一格式 */
export async function rasterize(bytes, renderFn, opts = {}) {
  const { dpi = 120, quality = 0.72, affected = null, redacts = [] } = opts;
  const src = await loadDoc(bytes);
  const n = src.getPageCount();
  const out = await PDFDocument.create();
  const scale = dpi / 72;
  for (let i = 0; i < n; i++) {
    const hit = !affected || affected.has(i);
    if (!hit) {
      const [p] = await out.copyPages(src, [i]);
      out.addPage(p);
      continue;
    }
    const canvas = await renderFn(i + 1, scale);
    const boxes = redacts.filter((r) => r.page === i + 1);
    const ctx = canvas.getContext('2d');
    if (boxes.length) {
      ctx.fillStyle = '#000';
      for (const b of boxes) {
        const rect = b.rect;
        const x = rect[0] * scale;
        const y = canvas.height - rect[3] * scale;
        ctx.fillRect(x, y, (rect[2] - rect[0]) * scale, (rect[3] - rect[1]) * scale);
      }
    }
    const jpg = canvas.toDataURL('image/jpeg', quality);
    const img = await out.embedJpg(dataUrlBytes(jpg));
    const page = out.addPage([canvas.width / scale, canvas.height / scale]);
    page.drawImage(img, { x: 0, y: 0, width: canvas.width / scale, height: canvas.height / scale });
  }
  copyMeta(src, out);
  return out.save({ useObjectStreams: true });
}

/** 按顺序重建：把栅格页插回原位置（压缩时用不到，保留接口） */
export async function rebuildWithOrder(bytes, pageBuilders) {
  const out = await PDFDocument.create();
  for (const b of pageBuilders) {
    if (b.copy) {
      const [p] = await out.copyPages(b.from, [b.index]);
      out.addPage(p);
    } else if (b.image) {
      const page = out.addPage(b.size);
      page.drawImage(b.image, { x: 0, y: 0, width: b.size[0], height: b.size[1] });
    }
  }
  return out.save();
}

export async function setMetadata(bytes, patch) {
  const pdfDoc = await loadDoc(bytes);
  if (patch.title != null) pdfDoc.setTitle(patch.title);
  if (patch.author != null) pdfDoc.setAuthor(patch.author);
  if (patch.subject != null) pdfDoc.setSubject(patch.subject);
  if (patch.keywords != null) pdfDoc.setKeywords(String(patch.keywords).split(/[,，;；]/).map((s) => s.trim()).filter(Boolean));
  if (patch.creator != null) pdfDoc.setCreator(patch.creator);
  pdfDoc.setProducer('MiniPDF');
  pdfDoc.setModificationDate(new Date());
  return pdfDoc.save();
}

export async function pageSizes(bytes) {
  const pdfDoc = await loadDoc(bytes);
  return pdfDoc.getPages().map((p) => {
    const { width, height } = p.getSize();
    return { width, height, rotation: p.getRotation().angle || 0 };
  });
}
