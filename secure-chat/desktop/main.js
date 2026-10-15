const { app, BrowserWindow, Tray, Menu, shell, ipcMain, session, desktopCapturer, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { detect } = require('./games');
const ptt = require('./ptt');

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
let cfg = { server: '', openAtLogin: false, closeToTray: true, gameDetect: false };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile(), 'utf8')) }; } catch { /* first run */ }
const save = () => { try { fs.writeFileSync(cfgFile(), JSON.stringify(cfg)); } catch { /* ignore */ } };

let win = null, tray = null, quitting = false, gameTimer = null, lastGame = '';
const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));

function normalizeUrl(v) {
  let s = String(v || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !local) return null; // the chat needs HTTPS (or localhost)
    return u.origin + '/';
  } catch { return null; }
}
const origin = () => { try { return new URL(cfg.server).origin; } catch { return ''; } };
const fromServer = (url) => { try { return new URL(url).origin === origin(); } catch { return false; } };

function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 700, minHeight: 500, icon, backgroundColor: '#16171d', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => { if (!quitting && cfg.closeToTray && tray) { e.preventDefault(); win.hide(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!fromServer(url) && !url.startsWith('file:')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  load();
}

function load() {
  if (!win) return;
  if (!cfg.server) {
    ipcMain.removeHandler('setup:save');
    ipcMain.handle('setup:save', (_e, v) => { const u = normalizeUrl(v); if (!u) return 'Enter an https:// address.'; cfg.server = u; save(); win.loadURL(u); return ''; });
    win.loadFile(path.join(__dirname, 'setup.html'), {});
  } else {
    win.loadURL(cfg.server).catch(() => {});
    win.webContents.once('did-fail-load', () => dialog.showMessageBox(win, { type: 'error', message: 'Could not reach ' + cfg.server, detail: 'Check the address or that the host is running. Use Hideout > Change server… to fix it.' }));
  }
}

function applyLogin() { try { app.setLoginItemSettings({ openAtLogin: !!cfg.openAtLogin }); } catch { /* ignore */ } }

function pollGame() {
  if (!cfg.gameDetect) return;
  const cmd = process.platform === 'win32' ? ['tasklist', ['/fo', 'csv', '/nh']] : ['ps', ['-A', '-o', 'comm=']];
  execFile(cmd[0], cmd[1], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
    if (err) return;
    const g = detect(out);
    if (g !== lastGame) { lastGame = g; if (win) win.webContents.send('game', g); }
  });
}
function setGameDetect(on) {
  cfg.gameDetect = !!on;
  clearInterval(gameTimer);
  if (on) { pollGame(); gameTimer = setInterval(pollGame, 15000); }
  else if (lastGame) { lastGame = ''; if (win) win.webContents.send('game', ''); }
}

function buildMenu() {
  const t = [
    { label: 'Hideout', submenu: [
      { label: 'Change server…', click: () => { cfg.server = ''; save(); load(); } },
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => win && win.reload() },
      { type: 'separator' }, { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => { quitting = true; app.quit(); } },
    ] },
    { label: 'Edit', role: 'editMenu' }, { label: 'View', role: 'viewMenu' }, { label: 'Window', role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

function createTray() {
  try {
    tray = new Tray(icon.resize({ width: 18, height: 18 }));
    tray.setToolTip('Hideout');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Hideout', click: () => { win.show(); win.focus(); } },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => { if (win.isVisible()) win.focus(); else win.show(); });
  } catch { tray = null; }
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; ptt.stop(); });
app.on('activate', () => { if (win) win.show(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' || quitting) app.quit(); });

app.whenReady().then(() => {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'notifications', 'display-capture', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(allowed.has(perm) && fromServer(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((wc, perm, reqOrigin) => allowed.has(perm) && fromServer(reqOrigin || ''));
  // Screen share: let the person pick a screen or window.
  ses.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } });
      if (!sources.length) return cb({});
      const menu = Menu.buildFromTemplate([
        ...sources.slice(0, 15).map((s) => ({ label: s.name.slice(0, 60), icon: s.thumbnail.resize({ width: 48 }), click: () => cb({ video: s }) })),
        { type: 'separator' }, { label: 'Cancel', click: () => cb({}) },
      ]);
      menu.once('menu-will-close', () => setTimeout(() => { try { cb({}); } catch { /* already answered */ } }, 300));
      menu.popup({ window: win });
    } catch { cb({}); }
  });

  ipcMain.handle('settings:get', () => ({ openAtLogin: cfg.openAtLogin, closeToTray: cfg.closeToTray, gameDetect: cfg.gameDetect, pttAvailable: ptt.available() }));
  ipcMain.handle('settings:set', (_e, s) => {
    if (typeof s !== 'object' || !s) return;
    if ('openAtLogin' in s) { cfg.openAtLogin = !!s.openAtLogin; applyLogin(); }
    if ('closeToTray' in s) cfg.closeToTray = !!s.closeToTray;
    if ('gameDetect' in s && !!s.gameDetect !== cfg.gameDetect) setGameDetect(s.gameDetect);
    save();
  });
  ipcMain.handle('ptt:set', (_e, key) => ptt.setKey(key));
  ipcMain.on('badge', (_e, n) => {
    try { app.setBadgeCount(n); } catch { /* unsupported */ }
    if (process.platform === 'win32' && win && !win.isFocused()) win.flashFrame(n > 0);
    if (tray) tray.setToolTip(n ? `Hideout (${n} unread)` : 'Hideout');
  });

  buildMenu();
  createWindow();
  createTray();
  applyLogin();
  ptt.start((down) => { if (win) win.webContents.send('ptt', down); });
  if (cfg.gameDetect) setGameDetect(true);
});
