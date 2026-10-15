const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hideoutDesktop', {
  isDesktop: true,
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  setPtt: (key) => ipcRenderer.invoke('ptt:set', String(key || '')),
  onPtt: (cb) => ipcRenderer.on('ptt', (_e, down) => cb(!!down)),
  onGame: (cb) => ipcRenderer.on('game', (_e, name) => cb(String(name || ''))),
  setBadge: (n) => ipcRenderer.send('badge', Number(n) || 0),
});
contextBridge.exposeInMainWorld('setup', { save: (v) => ipcRenderer.invoke('setup:save', String(v || '')) });
