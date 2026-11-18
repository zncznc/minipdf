'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('minipdf', {
  platform: process.platform,
  win: {
    minimize: () => invoke('win:action', 'minimize'),
    maximize: () => invoke('win:action', 'maximize'),
    close: () => invoke('win:action', 'close'),
    fullscreen: () => invoke('win:action', 'fullscreen'),
    isMaximized: () => invoke('win:isMaximized'),
  },
  openPdf: (opts) => invoke('dialog:openPdf', opts),
  readFile: (p) => invoke('file:read', p),
  writeFile: (p, data, opts) => invoke('file:write', p, data, opts),
  savePdfDialog: (name) => invoke('dialog:savePdf', name),
  saveFileDialog: (opts) => invoke('dialog:saveFile', opts),
  chooseDir: (title) => invoke('dialog:chooseDir', title),
  recent: () => invoke('app:recent'),
  recentClear: () => invoke('app:recentClear'),
  info: () => invoke('app:info'),
  reveal: (p) => invoke('shell:reveal', p),
  openExternal: (u) => invoke('shell:openExternal', u),
  printPages: (pages) => invoke('print:pages', pages),
  onBridgeCall: (fn) => ipcRenderer.on('bridge:call', (_e, msg) => fn(msg)),
  onCloseRequest: (fn) => ipcRenderer.on('app:close-request', () => fn()),
  closeResponse: (ok) => ipcRenderer.send('app:close-response', ok),
  bridgeResult: (payload) => ipcRenderer.send('bridge:result', payload),
  bridgeReady: () => ipcRenderer.send('bridge:ready'),
});
