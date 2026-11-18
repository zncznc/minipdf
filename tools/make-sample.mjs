import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const W = 595.28, H = 841.89;
const outDir = path.join(process.cwd(), 'samples');
fs.mkdirSync(outDir, { recursive: true });

const doc = await PDFDocument.create();
doc.setTitle('MiniPDF Sample Report');
doc.setAuthor('MiniPDF');
doc.setSubject('Rendering, search and annotation test fixture');
doc.setCreator('MiniPDF tools/make-sample.mjs');
doc.setProducer('pdf-lib');

const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

function pageBase(p, n, title) {
  p.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: rgb(0.09, 0.13, 0.18) });
  p.drawText('MINIPDF', { x: 48, y: H - 40, size: 18, font: bold, color: rgb(1, 1, 1) });
  p.drawText(title, { x: 48, y: H - 56, size: 9, font, color: rgb(0.72, 0.78, 0.84) });
  p.drawText(`Page ${n}`, { x: W - 80, y: 30, size: 9, font, color: rgb(0.45, 0.48, 0.52) });
  p.drawRectangle({ x: 48, y: 44, width: W - 96, height: 0.8, color: rgb(0.82, 0.84, 0.86) });
}

function para(p, text, y, opts = {}) {
  const size = opts.size || 10.5;
  const maxW = W - 96;
  const words = text.split(' ');
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (font.widthOfTextAtSize(test, size) > maxW) {
      p.drawText(line, { x: 48, y, size, font: opts.font || font, color: opts.color || rgb(0.16, 0.18, 0.2) });
      line = word;
      y -= size * 1.55;
    } else line = test;
  }
  if (line) {
    p.drawText(line, { x: 48, y, size, font: opts.font || font, color: opts.color || rgb(0.16, 0.18, 0.2) });
    y -= size * 1.55;
  }
  return y;
}

const body = [
  'This document exists so the renderer, the text layer, the search index and the annotation writer can be checked against something with real structure: multiple pages, mixed type sizes, tables, vector shapes and a form.',
  'Every paragraph is real text, not an image. Select a sentence and the highlight tool should snap to the exact line box. Search for a phrase and the hit rectangles come from the PDF text items, not from a screenshot diff.',
  'Page geometry is A4 at 595 by 842 points. The page header is a filled rectangle; the rule under the body is a stroked line. Both should stay crisp at 400 percent zoom, which is the point of rendering through pdf.js instead of pre-rasterising.',
];

for (let n = 1; n <= 5; n++) {
  const p = doc.addPage([W, H]);
  pageBase(p, n, 'Sample report · section ' + n);
  let y = H - 120;
  p.drawText(`Section ${n}`, { x: 48, y, size: 26, font: bold, color: rgb(0.08, 0.11, 0.15) });
  y -= 26;
  p.drawText('Rendering, text extraction and page operations', { x: 48, y, size: 11, font, color: rgb(0.45, 0.49, 0.54) });
  y -= 34;
  for (const t of body) {
    y = para(p, t, y);
    y -= 12;
  }

  if (n === 2) {
    // 表格
    const rows = [
      ['Feature', 'Engine', 'Writes to file'],
      ['Render', 'pdf.js 4.10', 'no'],
      ['Search', 'text content', 'no'],
      ['Annotate', 'pdf-lib', 'yes'],
      ['Page ops', 'pdf-lib', 'yes'],
    ];
    let ty = y - 10;
    p.drawRectangle({ x: 48, y: ty - 6, width: W - 96, height: 18, color: rgb(0.93, 0.95, 0.97) });
    rows.forEach((row, i) => {
      const yy = ty - i * 20;
      if (i > 0) p.drawRectangle({ x: 48, y: yy - 6, width: W - 96, height: 1, color: rgb(0.9, 0.91, 0.93) });
      [48, 230, 420].forEach((x, k) => {
        p.drawText(row[k], { x, y: yy, size: 9.5, font: i === 0 ? bold : font, color: rgb(0.18, 0.2, 0.23) });
      });
    });
    y = ty - rows.length * 20 - 24;
    p.drawText('Note: the table above is drawn with vector fills and text runs.', { x: 48, y, size: 9, font, color: rgb(0.45, 0.49, 0.54) });
    y -= 22;
  }

  if (n === 3) {
    // 图形
    for (let i = 0; i < 6; i++) {
      p.drawRectangle({
        x: 48 + i * 76, y: y - 70, width: 60, height: 60,
        color: rgb(0.08 + i * 0.02, 0.35 + i * 0.06, 0.85 - i * 0.09),
      });
      p.drawText(String(i + 1), { x: 74 + i * 76, y: y - 42, size: 14, font: bold, color: rgb(1, 1, 1) });
    }
    y -= 96;
    p.drawCircle({ x: 120, y: y - 20, size: 36, color: rgb(0.97, 0.72, 0.13) });
    p.drawCircle({ x: 150, y: y - 20, size: 36, color: rgb(0.13, 0.45, 0.9), opacity: 0.65 });
    y -= 70;
  }

  if (n === 4) {
    // 表单
    y -= 14;
    p.drawText('Fillable fields', { x: 48, y, size: 14, font: bold, color: rgb(0.1, 0.12, 0.15) });
    y -= 58;
    const form = doc.getForm();
    const mk = (label, name, yy) => {
      p.drawText(label, { x: 48, y: yy + 18, size: 9.5, font, color: rgb(0.28, 0.31, 0.35) });
      const tf = form.createTextField(name);
      tf.addToPage(p, { x: 48, y: yy - 6, width: 300, height: 22, borderWidth: 0.8, borderColor: rgb(0.6, 0.66, 0.72) });
    };
    mk('Full name', 'fullName', y);
    y -= 50;
    mk('Email', 'email', y);
    y -= 50;
    const cb = form.createCheckBox('agree');
    cb.addToPage(p, { x: 48, y: y - 4, width: 14, height: 14, borderWidth: 0.8 });
    p.drawText('I agree to the sample terms', { x: 70, y, size: 10, font, color: rgb(0.2, 0.22, 0.25) });
    y -= 60;
    para(p, 'The fields above are real AcroForm widgets. Typing into the blue overlays and saving writes values back into the field dictionary, so any other reader shows the same values.', y);
  }

  if (n === 5) {
    p.drawRectangle({ x: 48, y: y - 84, width: W - 96, height: 84, color: rgb(0.96, 0.97, 0.98) });
    p.drawText('What is intentionally missing', { x: 62, y: y - 22, size: 11, font: bold, color: rgb(0.15, 0.17, 0.2) });
    p.drawText('Text reflow editing, OCR and AES encryption are not implemented.', { x: 62, y: y - 42, size: 9.5, font, color: rgb(0.35, 0.38, 0.42) });
    p.drawText('This build refuses to fake them instead of shipping a shell.', { x: 62, y: y - 58, size: 9.5, font, color: rgb(0.35, 0.38, 0.42) });
  }
}

const bytes = await doc.save();
fs.writeFileSync(path.join(outDir, 'sample.pdf'), bytes);
console.log('wrote samples/sample.pdf', bytes.length, 'bytes');
