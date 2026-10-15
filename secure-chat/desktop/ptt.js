// Global push-to-talk: listens for one key even while another app is focused.
// Uses uiohook-napi; on macOS the app needs Input Monitoring / Accessibility permission.
let hook = null, Key = null, wanted = null, down = false, cb = () => {};
try { ({ uIOhook: hook, UiohookKey: Key } = require('uiohook-napi')); } catch { /* optional */ }

const NAMED = { ' ': 'Space', 'control': 'Ctrl', 'shift': 'Shift', 'alt': 'Alt', 'capslock': 'CapsLock', 'tab': 'Tab', '`': 'Backquote', 'enter': 'Enter', 'backspace': 'Backspace', 'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown', 'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight', ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal' };
function toCode(k) {
  if (!Key || !k) return null;
  let name = NAMED[k] || (/^f\d{1,2}$/.test(k) ? k.toUpperCase() : /^[a-z]$/.test(k) ? k.toUpperCase() : k);
  return Key[name] ?? null;
}
function start(onChange) {
  cb = onChange;
  if (!hook) return false;
  hook.on('keydown', (e) => { if (wanted !== null && e.keycode === wanted && !down) { down = true; cb(true); } });
  hook.on('keyup', (e) => { if (wanted !== null && e.keycode === wanted && down) { down = false; cb(false); } });
  try { hook.start(); return true; } catch { return false; }
}
function setKey(k) { wanted = toCode(String(k || '').toLowerCase()); if (down) { down = false; cb(false); } return wanted !== null; }
function stop() { try { hook && hook.stop(); } catch { /* ignore */ } }
module.exports = { start, setKey, stop, available: () => !!hook };
