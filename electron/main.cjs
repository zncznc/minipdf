'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, screen, BrowserWindow: BW } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const crypto = require('node:crypto');

const APP_DIR = path.join(__dirname, '..', 'app');
const STATE_FILE = () => path.join(app.getPath('userData'), 'state.json');
const SAMPLE_DIR = path.join(__dirname, '..', 'samples');

let mainWindow = null;
let serverPort = 0;
let bridgeServer = null;
let bridgePort = 0;

/* ------------------------------------------------------------------ */
/* 静态服务：让 ES module / worker / cmaps 都能按 http 同源加载        */
/* ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.bcmap': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        let base = APP_DIR;
        if (urlPath.startsWith('/samples/')) {
          base = SAMPLE_DIR;
          urlPath = urlPath.slice('/samples'.length);
        }
        const filePath = path.join(base, path.posix.normalize(urlPath));
        if (!filePath.startsWith(base)) {
          res.writeHead(403).end('forbidden');
          return;
        }
        const buf = await fsp.readFile(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
      } catch {
        res.writeHead(404).end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      serverPort = server.address().port;
      resolve(serverPort);
    });
  });
}

/* ------------------------------------------------------------------ */
/* 状态持久化                                                          */
/* ------------------------------------------------------------------ */
async function readState() {
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE(), 'utf8'));
  } catch {
    return { recent: [], bounds: null };
  }
}
async function writeState(patch) {
  const cur = await readState();
  const next = { ...cur, ...patch };
  try {
    await fsp.mkdir(path.dirname(STATE_FILE()), { recursive: true });
    await fsp.writeFile(STATE_FILE(), JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.error('state write failed', err);
  }
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */
async function createWindow() {
  const state = await readState();
  const bounds = state.bounds || {};
  const wa = screen.getPrimaryDisplay().workArea;
  // 只恢复位置，不恢复尺寸：Windows 高 DPI 下 getContentBounds 有 ±9px 取整误差，
  // 反复恢复会把窗口一点点撑大。
  const width = Math.min(1440, wa.width - 8);
  const height = Math.min(920, wa.height - 8);
  mainWindow = new BrowserWindow({
    width,
    height,
    x: Math.max(wa.x, Math.min(bounds.x ?? wa.x + 80, wa.x + wa.width - width)),
    y: Math.max(wa.y, Math.min(bounds.y ?? wa.y + 40, wa.y + wa.height - height)),
    minWidth: 980,
    minHeight: 620,
    useContentSize: true,
    frame: false,
    backgroundColor: '#33383b',
    show: false,
    title: 'MiniPDF',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    writeState({ bounds: mainWindow.getContentBounds() });
  };
  mainWindow.on('resize', debounce(saveBounds, 400));
  mainWindow.on('move', debounce(saveBounds, 400));

  const argPdf = process.argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a));
  const q = argPdf ? `?open=${encodeURIComponent(path.resolve(argPdf))}` : '';
  const url = process.env.MINIPDF_URL || `http://127.0.0.1:${serverPort}/index.html${q}`;
  await mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });

  let allowClose = false;
  mainWindow.on('close', (e) => {
    if (allowClose || process.env.MINIPDF_SMOKE) return;
    e.preventDefault();
    mainWindow.webContents.send('app:close-request');
  });
  ipcMain.removeAllListeners('app:close-response');
  ipcMain.on('app:close-response', (e, ok) => {
    if (!ok) return;
    allowClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.env.MINIPDF_SMOKE) {
    setTimeout(() => runSmoke().catch((err) => {
      console.log('SMOKE_FAIL ' + (err && err.stack || err));
      app.quit();
    }), Number(process.env.MINIPDF_SMOKE_DELAY || 3500));
  }
  if (process.env.MINIPDF_DEBUG) {
    mainWindow.webContents.on('console-message', (_e, level, msg, line, source) => {
      console.log(`[renderer:${level}] ${msg} (${source}:${line})`);
    });
  }
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/* ------------------------------------------------------------------ */
/* 文件 / 对话框 IPC                                                   */
/* ------------------------------------------------------------------ */
ipcMain.handle('win:action', (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  if (action === 'minimize') w.minimize();
  else if (action === 'maximize') w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === 'close') w.close();
  else if (action === 'fullscreen') w.setFullScreen(!w.isFullScreen());
  return w.isMaximized();
});

ipcMain.handle('win:isMaximized', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return !!(w && w.isMaximized());
});

ipcMain.handle('dialog:openPdf', async (e, opts = {}) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(w, {
    title: opts.title || '打开 PDF',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  });
  if (result.canceled) return [];
  const files = [];
  for (const p of result.filePaths) {
    try {
      const buf = await fsp.readFile(p);
      files.push({ path: p, name: path.basename(p), data: new Uint8Array(buf) });
      await addRecent(p);
    } catch (err) {
      console.error('read failed', p, err);
    }
  }
  return files;
});

ipcMain.handle('file:read', async (e, filePath) => {
  try {
    const buf = await fsp.readFile(filePath);
    await addRecent(filePath);
    return { path: filePath, name: path.basename(filePath), data: new Uint8Array(buf) };
  } catch (err) {
    return { error: String(err.message || err) };
  }
});

ipcMain.handle('file:write', async (e, filePath, data, opts = {}) => {
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, Buffer.from(data));
    if (opts.addRecent !== false) await addRecent(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('dialog:savePdf', async (e, defaultName) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showSaveDialog(w, {
    title: '保存 PDF',
    defaultPath: defaultName || 'document.pdf',
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:saveFile', async (e, opts) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showSaveDialog(w, {
    title: opts.title || '保存',
    defaultPath: opts.defaultName,
    filters: opts.filters || [{ name: '所有文件', extensions: ['*'] }],
  });
  return result.canceled ? null : result.filePath;
});

ipcMain.handle('dialog:chooseDir', async (e, title) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(w, {
    title: title || '选择文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('app:recent', async () => {
  const s = await readState();
  const out = [];
  for (const r of s.recent || []) {
    try {
      const st = await fsp.stat(r.path);
      out.push({ ...r, size: st.size, exists: true });
    } catch {
      out.push({ ...r, exists: false });
    }
  }
  return out;
});

ipcMain.handle('app:recentClear', async () => {
  await writeState({ recent: [] });
  return true;
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  userData: app.getPath('userData'),
  bridgePort,
}));

ipcMain.handle('shell:reveal', (e, p) => {
  shell.showItemInFolder(p);
});

ipcMain.handle('shell:openExternal', (e, u) => {
  if (/^https?:/.test(u)) shell.openExternal(u);
});

async function addRecent(filePath) {
  const state = await readState();
  const list = (state.recent || []).filter((r) => r.path !== filePath);
  list.unshift({ path: filePath, name: path.basename(filePath), at: Date.now() });
  await writeState({ recent: list.slice(0, 20) });
}

/* ------------------------------------------------------------------ */
/* 打印：把页面位图放进独立窗口，走系统打印对话框                      */
/* ------------------------------------------------------------------ */
ipcMain.handle('print:pages', async (e, pages) => {
  // pages: [{ dataUrl, width, height }]
  const win = new BW({
    width: 900,
    height: 1200,
    show: false,
    webPreferences: { offscreen: false, javascript: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    html,body{margin:0;padding:0;}
    .p{page-break-after:always;display:block;overflow:hidden;}
    .p:last-child{page-break-after:auto;}
    img{width:100%;height:100%;display:block;}
  </style></head><body>
  ${pages.map((p) => `<div class="p" style="width:${p.wPt}pt;height:${p.hPt}pt"><img src="${p.dataUrl}"></div>`).join('')}
  </body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return await new Promise((resolve) => {
    setTimeout(() => {
      win.webContents.print({ printBackground: true, margins: { marginType: 'none' } }, (ok, reason) => {
        if (!win.isDestroyed()) win.close();
        resolve({ ok, reason });
      });
    }, 700);
  });
});

/* ------------------------------------------------------------------ */
/* Agent 桥（沿用 REA 的 GUI 协议骨架：一行一 JSON，宿主持有真相）      */
/* ------------------------------------------------------------------ */
function startBridge() {
  if (process.env.MINIPDF_NO_BRIDGE) return;
  bridgeServer = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }
    const send = (code, obj) => {
      res.writeHead(code);
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'GET' && req.url.startsWith('/current_view')) {
        const view = await callRenderer('current_view', {});
        return send(200, { ok: true, text: JSON.stringify(view), view });
      }
      if (req.method === 'GET' && req.url.startsWith('/health')) {
        return send(200, { ok: true, app: 'MiniPDF', port: bridgePort });
      }
      if (req.method === 'POST' && req.url.startsWith('/command')) {
        const body = await readBody(req);
        const { tool, args } = JSON.parse(body || '{}');
        if (!tool) return send(400, { ok: false, error: '缺少 tool 字段' });
        const result = await callRenderer(tool, args || {});
        return send(200, { ok: true, text: typeof result === 'string' ? result : JSON.stringify(result), result });
      }
      send(404, { ok: false, error: '未知接口。可用：GET /current_view，GET /health，POST /command {tool,args}' });
    } catch (err) {
      send(500, { ok: false, error: String(err.message || err) });
    }
  });
  bridgeServer.listen(Number(process.env.MINIPDF_BRIDGE_PORT || 7857), '127.0.0.1', () => {
    bridgePort = bridgeServer.address().port;
  });
  bridgeServer.on('error', () => { bridgePort = 0; });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
}

const pendingBridge = new Map();
function callRenderer(tool, args) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) return reject(new Error('窗口未就绪'));
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingBridge.delete(id);
      reject(new Error(`工具 ${tool} 超时`));
    }, 8000);
    pendingBridge.set(id, { resolve, reject, timer });
    mainWindow.webContents.send('bridge:call', { id, tool, args });
  });
}
ipcMain.on('bridge:result', (e, { id, ok, result, error }) => {
  const p = pendingBridge.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  pendingBridge.delete(id);
  ok ? p.resolve(result) : p.reject(new Error(error || 'renderer error'));
});
ipcMain.on('bridge:ready', () => {});

/* ------------------------------------------------------------------ */
/* 无头自检：截图 + 关键状态                                            */
/* ------------------------------------------------------------------ */
async function runSmoke() {
  const out = process.env.MINIPDF_SMOKE;
  const wc = mainWindow.webContents;
  const bootErrors = await wc.executeJavaScript('window.__bootErrors || []', true).catch(() => []);
  if (bootErrors.length) console.log('BOOT_ERRORS ' + JSON.stringify(bootErrors, null, 1));
  const scene = process.env.MINIPDF_SCENE || 'read';
  const data = await wc.executeJavaScript(`window.__minipdfSmoke ? window.__minipdfSmoke(${JSON.stringify(scene)}) : {error:"no smoke hook"}`, true);
  console.log('SMOKE ' + JSON.stringify(data));
  await new Promise((r) => setTimeout(r, 600));
  const img = await wc.capturePage();
  await fsp.writeFile(out, img.toPNG());
  console.log('SMOKE_SHOT ' + out);
  console.log('SMOKE_OK');
  app.quit();
}

/* ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  await startStaticServer();
  startBridge();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
