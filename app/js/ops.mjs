/* PDF 写操作：全部经 pdf-lib 落到真实文件 */
const L = window.PDFLib;
const { PDFDocument, degrees, PDFName, PDFHexString, PDFString, PDFArray, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = L;

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

/** 文本框 → 位图（避免 CJK 字体嵌入问题，保证所见即所得） */
export function textboxToPng(a, scale = 2) {
  const rect = a.rects[0];
  const w = Math.max(24, rect[2] - rect[0]);
  const hh = Math.max(14, rect[3] - rect[1]);
  const pad = 2;
  const fs = a.fontSize || 12;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w * scale);
  canvas.height = Math.ceil(hh * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.92;
  ctx.fillRect(0, 0, w, hh);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#111111';
  ctx.font = `${fs}px "Microsoft YaHei", "Segoe UI", sans-serif`;
  ctx.textBaseline = 'top';
  const text = a.content || '';
  const maxW = w - pad * 2;
  let line = '';
  let y = pad;
  const lineH = fs * 1.32;
  for (const ch of text) {
    if (ch === '\n') {
      ctx.fillText(line, pad, y);
      line = '';
      y += lineH;
      continue;
    }
    const test = line + ch;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, pad, y);
      line = ch;
      y += lineH;
    } else line = test;
    if (y > hh - lineH) break;
  }
  if (line) ctx.fillText(line, pad, y);
  return canvas.toDataURL('image/png');
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
      const dataUrl = a.type === 'textbox' ? textboxToPng(a, 3) : a.dataUrl;
      if (dataUrl) await drawRaster(pdfDoc, pages[a.page - 1], dataUrl, a.rects[0]);
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
