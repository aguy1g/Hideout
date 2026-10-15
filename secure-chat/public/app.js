(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const lc = (s) => String(s).toLowerCase();
  // Public STUN helps friends connect through home routers. It only sees IP addresses, never audio.
  // The server may add a TURN relay (for strict networks); see loadIce().
  let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  let iceLoadedAt = 0;
  const EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀'];
  const MAX_FILE = 8 * 1024 * 1024 - 100;
  const LIMITS = { name: 32, bio: 190, avatar: 30000, banner: 110000 }; // image sizes are data-URL characters
  const PROFILE_AAD = 'hideout-profile-v1';
  const USER_RE = /^[A-Za-z0-9_.]{3,20}$/;

  // account (set after log in)
  let account = null; // { username, token, key, masterRaw, method, profile, idk, idKey, idPub }
  // room
  let ws = null, roomKey = null, room = '', myId = '', myUid = '', ownerUid = '', isOwner = false;
  let joined = false, voiceOn = false, muted = false, localStream = null, localWatch = null;
  let endedReason = '';
  let active = '';                         // conversation key: 'c:<channelId>' or 'd:<uid>'
  let lastDrawn = null;
  let call = null;                         // private call: { id: peerId, state: 'out' | 'in' | 'on', timer }
  let bans = [];
  let replyTo = null, editing = null, pendingFile = null, wsQueue = Promise.resolve();
  const peers = new Map();                 // peerId -> peer state (username/uid come from the server)
  const convs = new Map();                 // key -> { key, kind, id, name, msgs[], byId, unread, loaded }
  const dmKeys = new Map();                // uid -> AES key shared with that person
  const knownUsers = new Map();            // uid -> username
  const blobCache = new Map();             // file id -> object URL of the decrypted file
  const speaking = new Set();              // lowercase usernames currently talking
  const profiles = new Map();              // lowercase username -> profile
  const prefs = { sound: true, desktop: false };
  let roomSettings = { slowMode: 0, allowFiles: true, membersCanCreateChannels: true, lockJoin: false, retentionDays: 0, maxMembers: 12 };
  let muted_ = new Set();                  // conversations muted on this device
  const lastSent = new Map();              // channel id -> time of my last message (slow mode)
  // Looks and feel, saved on this device only.
  const look = { autoGame: false, theme: 'auto', accent: '', size: 15, density: 'cozy', h24: false, joins: true, motion: false, volume: 60, typing: true, notify: 'all', mic: '', ptt: false, pttKey: 'v' };
  try { Object.assign(look, JSON.parse(localStorage.getItem('hideout.look') || '{}')); } catch { /* defaults */ }
  const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || '') || d; } catch { return d; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };
  let blocked = jget('hideout.blocked', {});   // uid -> username
  let nicks = jget('hideout.nick', {});        // uid -> private nickname
  let vols = jget('hideout.vol', {});          // uid -> 0..100
  let myStatus = jget('hideout.status', { state: 'online', text: '' });
  let autoAway = false, awayTimer = null, pttDown = false, searchTerm = '', screenStream = null, lastTypingSent = 0;
  const typingBy = new Map();              // conversation key -> Map(uid -> timer)
  const stageEls = new Map();              // 'peerId:kind' -> element
  let readTimes = {};
  let convOrder = [];
  let threadRoot = null, threadConv = null;
  const pendingDeletes = new Map();
  let saved = jget('hideout.saved', []);
  let drafts = jget('hideout.drafts', {});
  const desk = window.hideoutDesktop || null;
  let gameName = '';
  function applyLook() {
    const root = document.documentElement;
    const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    root.dataset.theme = look.theme === 'auto' ? dark : look.theme;
    for (const k of ['--accent', '--accent2']) root.style.removeProperty(k);
    if (/^#[0-9a-f]{6}$/i.test(look.accent)) { root.style.setProperty('--accent', look.accent); root.style.setProperty('--accent2', look.accent); }
    document.body.style.fontSize = Math.min(24, Math.max(12, Number(look.size) || 15)) + 'px';
    root.classList.toggle('dense', look.density === 'dense');
    root.classList.toggle('nomotion', !!look.motion);
  }
  const saveLook = () => { try { localStorage.setItem('hideout.look', JSON.stringify(look)); } catch { /* ignore */ } applyLook(); };

  const setText = (id, t) => { $(id).textContent = t || ''; };
  const wsSend = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !look.h24 });
  const dmAad = (from, to) => `dm|${room}|${from}|${to}`;
  const strip = (s, keepNewlines) => String(s).replace(
    keepNewlines ? /[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/g : /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '');
  const secureOk = () => window.isSecureContext && window.crypto && crypto.subtle;
  const remember = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage may be blocked */ } };
  const recall = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };
  prefs.sound = recall('hideout.sound') !== '0';
  prefs.desktop = recall('hideout.desktop') === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted';

  // Small key-value store in the browser (IndexedDB) for "stay logged in". It can hold key objects
  // without exposing their bytes. Everything is best effort: if it's unavailable we simply don't remember.
  const idb = (() => {
    const open = () => new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
      const r = indexedDB.open('hideout', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const run = async (mode, fn) => {
      try {
        const db = await open();
        return await new Promise((res, rej) => {
          const tx = db.transaction('kv', mode);
          const req = fn(tx.objectStore('kv'));
          tx.oncomplete = () => { db.close(); res(req && req.result); };
          tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); };
        });
      } catch { return null; }
    };
    return {
      get: (k) => run('readonly', (s) => s.get(k)),
      set: (k, v) => run('readwrite', (s) => s.put(v, k)),
      del: (k) => run('readwrite', (s) => s.delete(k)),
    };
  })();

  // ---------- profiles ----------
  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    const hex = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
    return '#' + hex(f(0)) + hex(f(8)) + hex(f(4));
  }
  function colorFor(username) {
    let h = 0;
    for (const ch of lc(username)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return hslToHex(h % 360, 55, 48);
  }
  function initials(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const a = Array.from(parts[0] || '?')[0];
    const b = parts[1] ? Array.from(parts[1])[0] : '';
    return (a + b).toUpperCase();
  }
  const defaultProfile = (username) => ({ displayName: username, bio: '', color: colorFor(username), avatar: null, banner: null });

  const isImg = (s, max) => typeof s === 'string' && s.length <= max &&
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(s);

  // Profiles from other people are untrusted: validate every field.
  function cleanProfile(p, username) {
    if (!p || typeof p !== 'object') return null;
    const name = typeof p.displayName === 'string' ? strip(p.displayName).trim().slice(0, LIMITS.name) : '';
    return {
      displayName: name || username,
      bio: typeof p.bio === 'string' ? strip(p.bio, true).slice(0, LIMITS.bio) : '',
      color: typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : colorFor(username),
      avatar: isImg(p.avatar, LIMITS.avatar) ? p.avatar : null,
      banner: isImg(p.banner, LIMITS.banner) ? p.banner : null,
    };
  }

  const profileOf = (username) => profiles.get(lc(username)) || defaultProfile(username);
  const uidOfName = (username) => { for (const [u, n] of knownUsers) if (lc(n) === lc(username)) return u; return null; };
  const dispName = (username) => { const u = uidOfName(username); return (u && nicks[u]) || profileOf(username).displayName; };

  function makeAvatarFrom(profile, username, size, clickable) {
    const el = document.createElement(clickable ? 'button' : 'div');
    el.className = 'avatar';
    el.dataset.u = lc(username);
    if (speaking.has(lc(username))) el.classList.add('speaking');
    el.style.width = el.style.height = size + 'px';
    if (clickable) {
      el.type = 'button';
      el.setAttribute('aria-label', 'View profile of ' + profile.displayName);
      el.addEventListener('click', (e) => { e.stopPropagation(); openProfile(username); });
    }
    if (profile.avatar) {
      const img = document.createElement('img');
      img.src = profile.avatar;
      img.alt = '';
      el.append(img);
    } else {
      el.style.background = colorFor(username);
      el.style.fontSize = Math.round(size * 0.4) + 'px';
      el.textContent = initials(profile.displayName);
    }
    return el;
  }
  const makeAvatar = (username, size, clickable) => makeAvatarFrom(profileOf(username), username, size, clickable);

  function makeCardFrom(profile, username) {
    const card = document.createElement('div');
    card.className = 'pcard';
    const banner = document.createElement('div');
    banner.className = 'pbanner';
    banner.style.background = profile.color;
    if (profile.banner) {
      const img = document.createElement('img');
      img.src = profile.banner;
      img.alt = '';
      banner.append(img);
    }
    const av = makeAvatarFrom(profile, username, 92, false);
    av.classList.add('on-banner');
    const info = document.createElement('div');
    info.className = 'pinfo';
    const n = document.createElement('div');
    n.className = 'pname';
    n.textContent = profile.displayName;
    const u = document.createElement('div');
    u.className = 'puser';
    u.textContent = '@' + username;
    info.append(n, u);
    if (profile.bio) {
      const b = document.createElement('div');
      b.className = 'pbio';
      b.textContent = profile.bio;
      info.append(b);
    }
    card.append(banner, av, info);
    return card;
  }

  // ---------- screens & dialogs ----------
  function showScreen(name) {
    $('auth').hidden = name !== 'auth';
    $('home').hidden = name !== 'home';
    $('app').hidden = name !== 'app';
  }

  let modalOpener = null;
  function openModal(id, focusId) {
    modalOpener = document.activeElement;
    $(id).hidden = false;
    if (focusId) $(focusId).focus();
  }
  function closeModal(id) {
    $(id).hidden = true;
    if (modalOpener && modalOpener.focus && document.contains(modalOpener)) modalOpener.focus();
    modalOpener = null;
  }
  const CLOSABLE = ['thread', 'saved', 'switcher', 'shortcuts', 'adminmodal', 'pinsmodal', 'pollmodal', 'viewer', 'chmodal', 'roomset', 'account', 'editor', 'popover'];
  for (const id of CLOSABLE) {
    $(id).addEventListener('click', (e) => { if (e.target === $(id)) closeModal(id); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !$('rkey').hidden) return; // the recovery key dialog must be confirmed
    for (const id of CLOSABLE) if (!$(id).hidden) { closeModal(id); return; }
    if (replyTo || editing) cancelCompose();
  });

  function peerIdFor(username) {
    for (const [id, p] of peers) if (lc(p.username) === lc(username)) return id;
    return null;
  }
  function peerIdForUid(uid) {
    for (const [id, p] of peers) if (p.uid === uid) return id;
    return null;
  }

  function openProfile(username) {
    $('pop-body').textContent = '';
    $('pop-body').append(makeCardFrom(profileOf(username), username));
    const actions = $('pop-actions');
    actions.textContent = '';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.addEventListener('click', () => closeModal('popover'));
    if (account && lc(username) === lc(account.username)) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'primary';
      edit.textContent = 'Edit profile';
      edit.addEventListener('click', () => { closeModal('popover'); openEditor(); });
      actions.append(close, edit);
    } else {
      const pid = joined ? peerIdFor(username) : null;
      actions.append(close);
      if (pid && isOwner) {
        for (const kind of ['kick', 'ban']) {
          const b = el('button', '', kind === 'kick' ? 'Kick' : 'Ban');
          b.type = 'button';
          b.addEventListener('click', () => {
            const q = kind === 'kick' ? `Kick ${dispName(username)} out of the room? They can rejoin.` : `Ban ${dispName(username)} from this room?`;
            if (!window.confirm(q)) return;
            wsSend({ type: kind, id: pid });
            closeModal('popover');
          });
          actions.append(b);
        }
      }
      if (pid) {
        const dm = document.createElement('button');
        dm.type = 'button';
        dm.className = 'primary';
        dm.textContent = 'Message';
        dm.addEventListener('click', () => { closeModal('popover'); openConv(dmConvKey(peers.get(pid).uid)); });
        actions.append(dm);
      }
    }
    if (!(account && lc(username) === lc(account.username))) popoverExtras(username, joined ? peerIdFor(username) : null);
    openModal('popover');
  }

  // ---------- account: log in / sign up ----------
  let mode = 'login'; // 'login' | 'recovery' | 'signup'
  let inviteRequired = false;

  function setMode(m) {
    mode = m;
    $('tab-login').classList.toggle('active', m !== 'signup');
    $('tab-signup').classList.toggle('active', m === 'signup');
    $('pass-wrap').hidden = m === 'recovery';
    $('key-wrap').hidden = m !== 'recovery';
    $('confirm-wrap').hidden = m !== 'signup';
    $('invite-wrap').hidden = !(m === 'signup' && inviteRequired);
    $('auth-note').hidden = m !== 'signup';
    $('alt-login').hidden = m === 'signup';
    $('alt-login').textContent = m === 'recovery' ? 'Use my password instead' : 'Use a recovery key instead';
    $('auth-go').textContent = m === 'signup' ? 'Create account' : 'Log in';
    $('a-pass').autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    setText('auth-err', '');
  }
  $('tab-login').addEventListener('click', () => setMode('login'));
  $('tab-signup').addEventListener('click', () => setMode('signup'));
  $('alt-login').addEventListener('click', () => setMode(mode === 'recovery' ? 'login' : 'recovery'));

  async function api(pathname, { method = 'POST', body, token } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch(pathname, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch { throw new Error('Could not reach the server.'); }
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed (' + res.status + ').'), { status: res.status });
    return data;
  }

  // Logs in with a password or a recovery key. Both unlock the same master key.
  async function doLogin(username, secret, method) {
    const { salt } = await api('/api/salt', { body: { username, method } });
    const { auth, key } = await SC.deriveAccount(secret, salt);
    const r = await api('/api/login', { body: { username, auth, method } });
    let profileKey = key, masterRaw = null;
    if (r.wrap) {
      try { ({ key: profileKey, raw: masterRaw } = await SC.unwrapMaster(key, r.wrap)); }
      catch { throw new Error('Could not unlock your profile with that.'); }
    } else if (method === 'recovery') {
      throw new Error('Could not unlock your profile with that.');
    } // otherwise: an older account whose profile is keyed by the password directly
    let profile = null, idk = null;
    if (r.blob) {
      try {
        const o = await SC.open(profileKey, PROFILE_AAD, r.blob);
        profile = cleanProfile(o, r.username);
        if (SC.validIdentity(o.idk)) idk = o.idk;
      } catch { /* fall back below */ }
    }
    const acct = {
      username: r.username, token: r.token, key: profileKey, masterRaw, method,
      hasRecovery: !!r.hasRecovery, passwordChanged: false, legacy: !r.wrap, admin: !!r.admin,
      profile: profile || defaultProfile(r.username), idk,
    };
    await setupIdentity(acct, !!profile);
    return acct;
  }

  // Everyone has a long-term key pair for DMs, saved inside their encrypted profile.
  // Older accounts get one the first time they log in.
  async function setupIdentity(acct, canSave) {
    if (!acct.idk) {
      acct.idk = await SC.genIdentity();
      if (canSave) {
        try { await api('/api/profile', { method: 'PUT', token: acct.token, body: { blob: await SC.seal(acct.key, PROFILE_AAD, { ...acct.profile, idk: acct.idk }) } }); }
        catch { /* we'll try again next login */ }
      }
    }
    const id = await SC.importIdentity(acct.idk);
    acct.idKey = id;
    acct.idPub = id.pub;
  }

  const sealProfile = (key, profile, idk) => SC.seal(key, PROFILE_AAD, { ...profile, idk });

  async function doSignup(username, pass) {
    const master = await SC.newMasterKey();
    const salt = SC.randomSalt();
    const pw = await SC.deriveAccount(pass, salt);
    const recoveryKey = SC.generateRecoveryKey();
    const rkSalt = SC.randomSalt();
    const rk = await SC.deriveAccount(SC.normalizeRecoveryKey(recoveryKey), rkSalt);
    const profile = defaultProfile(username);
    const idk = await SC.genIdentity();
    const r = await api('/api/register', { body: {
      username, salt, auth: pw.auth,
      wrap: await SC.wrapMaster(pw.key, master.raw),
      blob: await sealProfile(master.key, profile, idk),
      rk: { salt: rkSalt, auth: rk.auth, wrap: await SC.wrapMaster(rk.key, master.raw) },
      invite: $('a-invite').value.trim(),
    } });
    const acct = {
      username: r.username, token: r.token, key: master.key, masterRaw: master.raw, method: 'password',
      hasRecovery: true, passwordChanged: false, legacy: false, profile, idk, admin: !!r.admin,
    };
    await setupIdentity(acct, false);
    return { acct, recoveryKey };
  }

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setText('auth-err', '');
    const username = $('a-user').value.trim();
    if (!secureOk()) return setText('auth-err', 'This page needs HTTPS (or localhost) for encryption to work.');
    if (!USER_RE.test(username)) return setText('auth-err', 'Usernames are 3-20 letters, numbers, underscores or dots.');
    let secret;
    if (mode === 'recovery') {
      secret = SC.normalizeRecoveryKey($('a-key').value);
      if (!secret) return setText('auth-err', "That recovery key doesn't look right. It has 32 letters and numbers.");
    } else {
      secret = $('a-pass').value;
      if (secret.length < 8) return setText('auth-err', 'Use a password of at least 8 characters.');
      if (mode === 'signup' && secret !== $('a-pass2').value) return setText('auth-err', "Those passwords don't match.");
    }
    const idleText = () => (mode === 'signup' ? 'Create account' : 'Log in');
    $('auth-go').disabled = true;
    $('auth-go').textContent = mode === 'signup' ? 'Creating account…' : 'Logging in…';
    try {
      let recoveryKey = null;
      if (mode === 'signup') ({ acct: account, recoveryKey } = await doSignup(username, secret));
      else account = await doLogin(username, secret, mode === 'recovery' ? 'recovery' : 'password');
      profiles.set(lc(account.username), account.profile);
      remember('hideout.user', account.username);
      remember('hideout.keep', $('a-keep').checked ? '1' : '0');
      if ($('a-keep').checked) saveSession(); else idb.del('session');
      for (const id of ['a-pass', 'a-pass2', 'a-key']) $(id).value = '';
      showScreen('home');
      renderHome();
      if (recoveryKey) showRecoveryKey(recoveryKey);
      else $('room').focus();
    } catch (err) {
      setText('auth-err', err.message);
    } finally {
      $('auth-go').disabled = false;
      $('auth-go').textContent = idleText();
    }
  });

  function renderHome() {
    $('home-card').textContent = '';
    $('home-card').append(makeCardFrom(account.profile, account.username));
    if (!$('room').value) $('room').value = recall('hideout.room');
    const needsPw = account.method === 'recovery' && !account.passwordChanged;
    $('home-note').hidden = !needsPw;
    setText('home-note', needsPw ? 'You signed in with your recovery key. Open Account to set a new password.' : '');
    renderSavedRooms();
  }

  // ---------- stay logged in / saved rooms (this device only) ----------
  function saveSession() {
    return idb.set('session', {
      username: account.username, token: account.token, key: account.key, method: account.method,
      hasRecovery: account.hasRecovery, legacy: !!account.legacy,
    });
  }

  async function renderSavedRooms() {
    const list = (await idb.get('rooms')) || [];
    const box = $('saved-rooms');
    box.textContent = '';
    $('saved-wrap').hidden = !list.length;
    for (const r of list) {
      const row = el('div', 'banrow');
      const go = el('button', 'primary', 'Join # ' + r.room);
      go.type = 'button';
      go.style.flex = '1';
      go.addEventListener('click', () => startJoin(r.room, { auth: r.auth, key: r.key }));
      const x = el('button', '', 'Forget');
      x.type = 'button';
      x.addEventListener('click', async () => {
        await idb.set('rooms', ((await idb.get('rooms')) || []).filter((q) => q.room !== r.room));
        renderSavedRooms();
      });
      row.append(go, x);
      box.append(row);
    }
  }

  async function rememberRoom(r, d) {
    const list = ((await idb.get('rooms')) || []).filter((q) => q.room !== r);
    list.unshift({ room: r, auth: d.auth, key: d.key });
    await idb.set('rooms', list.slice(0, 5));
  }

  async function forgetDevice() {
    await idb.del('session');
    await idb.del('rooms');
    try { localStorage.removeItem('hideout.drafts'); localStorage.removeItem('hideout.saved'); } catch { /* ignore */ }
  }

  // Back from a closed tab: check the saved login still works.
  async function tryResume() {
    const saved = await idb.get('session');
    if (!saved || !saved.token || !saved.key) return false;
    try {
      const r = await api('/api/resume', { token: saved.token });
      let masterRaw = null;
      if (!saved.legacy) masterRaw = new Uint8Array(await crypto.subtle.exportKey('raw', saved.key));
      let profile = null, idk = null;
      try {
        const o = await SC.open(saved.key, PROFILE_AAD, r.blob);
        profile = cleanProfile(o, r.username);
        if (SC.validIdentity(o.idk)) idk = o.idk;
      } catch { /* default profile below */ }
      const acct = {
        username: r.username, token: saved.token, key: saved.key, masterRaw, method: r.method || saved.method,
        hasRecovery: !!r.hasRecovery, passwordChanged: false, legacy: !!saved.legacy, admin: !!r.admin,
        profile: profile || defaultProfile(r.username), idk,
      };
      await setupIdentity(acct, !!profile);
      account = acct;
      profiles.set(lc(account.username), account.profile);
      remember('hideout.user', account.username);
      return true;
    } catch (err) {
      if (err.status === 401) await forgetDevice();
      return false;
    }
  }

  $('home-edit').addEventListener('click', openEditor);
  $('home-account').addEventListener('click', openAccount);
  $('home-logout').addEventListener('click', async () => {
    try { await api('/api/logout', { token: account.token }); } catch { /* ignore */ }
    await forgetDevice();
    location.reload(); // wipes keys and profile from memory
  });

  // ---------- profile editor ----------
  let draft = null;

  function renderDraftPreview() {
    const box = $('ed-preview');
    box.textContent = '';
    box.append(makeCardFrom({ ...draft, displayName: strip($('ed-name').value).trim() || account.username, bio: $('ed-bio').value }, account.username));
  }

  function openEditor() {
    draft = { ...account.profile };
    $('ed-name').value = draft.displayName;
    $('ed-bio').value = draft.bio;
    $('ed-color').value = draft.color;
    setText('ed-err', '');
    $('ed-save').disabled = false;
    renderDraftPreview();
    openModal('editor', 'ed-name');
  }

  $('ed-name').addEventListener('input', renderDraftPreview);
  $('ed-bio').addEventListener('input', renderDraftPreview);
  $('ed-color').addEventListener('input', () => { draft.color = $('ed-color').value; renderDraftPreview(); });
  $('ed-cancel').addEventListener('click', () => closeModal('editor'));
  $('ed-account').addEventListener('click', () => { closeModal('editor'); openAccount(); });
  $('ed-av-pick').addEventListener('click', () => $('ed-av-file').click());
  $('ed-bn-pick').addEventListener('click', () => $('ed-bn-file').click());
  $('ed-av-clear').addEventListener('click', () => { draft.avatar = null; renderDraftPreview(); });
  $('ed-bn-clear').addEventListener('click', () => { draft.banner = null; renderDraftPreview(); });

  // Center-crop to the target size and re-encode as JPEG, lowering quality until it fits.
  async function fileToDataUrl(file, w, h, maxLen) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Use a PNG, JPEG, WebP or GIF image.');
    if (file.size > 12 * 1024 * 1024) throw new Error('That image is too big (12 MB max).');
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error("Couldn't read that image."); }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const scale = Math.max(w / bmp.width, h / bmp.height);
    const dw = bmp.width * scale, dh = bmp.height * scale;
    ctx.fillStyle = '#1e222b';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh);
    if (bmp.close) bmp.close();
    for (let q = 0.9; q >= 0.3; q -= 0.1) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.length <= maxLen && isImg(url, maxLen)) return url;
    }
    throw new Error('That image is too detailed to shrink enough. Try a different one.');
  }

  async function pickImage(inputId, field, w, h, max) {
    const input = $(inputId);
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    setText('ed-err', '');
    try {
      draft[field] = await fileToDataUrl(file, w, h, max);
      renderDraftPreview();
    } catch (err) { setText('ed-err', err.message); }
  }
  $('ed-av-file').addEventListener('change', () => pickImage('ed-av-file', 'avatar', 128, 128, LIMITS.avatar));
  $('ed-bn-file').addEventListener('change', () => pickImage('ed-bn-file', 'banner', 600, 240, LIMITS.banner));

  $('ed-save').addEventListener('click', async () => {
    const name = strip($('ed-name').value).trim();
    if (!name) return setText('ed-err', 'Your display name can’t be empty.');
    const next = cleanProfile({ ...draft, displayName: name, bio: $('ed-bio').value, color: $('ed-color').value }, account.username);
    $('ed-save').disabled = true;
    setText('ed-err', '');
    try {
      const blob = await sealProfile(account.key, next, account.idk);
      await api('/api/profile', { method: 'PUT', token: account.token, body: { blob } });
      account.profile = next;
      profiles.set(lc(account.username), next);
      if (joined) for (const id of peers.keys()) queueSignal(id, { kind: 'profile', profile: next });
      closeModal('editor');
      refreshAll();
    } catch (err) {
      setText('ed-err', err.status === 401 ? 'Your session expired. Log out and sign in again.' : err.message);
      $('ed-save').disabled = false;
    }
  });

  function refreshAll() {
    renderHome();
    if (joined) redraw();
  }

  // ---------- account settings ----------
  const showMsg = (id, text, ok) => { const el = $(id); el.className = ok ? 'ok' : 'err'; el.textContent = text || ''; };

  function openAccount() {
    setText('ac-user', account.username);
    for (const id of ['ac-newuser', 'ac-cur', 'ac-new', 'ac-new2']) $(id).value = '';
    for (const id of ['ac-user-msg', 'ac-pw-msg', 'ac-rk-msg']) showMsg(id, '');
    const viaRecovery = account.method === 'recovery';
    $('ac-cur-wrap').hidden = viaRecovery;
    $('ac-cur-note').hidden = !viaRecovery;
    fillLook();
    setText('ac-dev-msg', '');
    $('ac-sound').checked = prefs.sound;
    $('ac-desktop').checked = prefs.desktop;
    setText('ac-notify-msg', '');
    setText('ac-rk-status', account.hasRecovery
      ? 'A recovery key is set. Making a new one replaces the old one.'
      : "You don't have a recovery key yet. Make one so you can log in if you forget your password.");
    openModal('account', 'ac-newuser');
  }
  $('ac-close').addEventListener('click', () => closeModal('account'));

  // Moves everything we know about a person from their old username to their new one.
  function renameEverywhere(oldName, newName, uid) {
    const p = profiles.get(lc(oldName));
    if (p) { profiles.delete(lc(oldName)); profiles.set(lc(newName), p); }
    if (uid) knownUsers.set(uid, newName);
    for (const c of convs.values()) {
      for (const msg of c.msgs) {
        if (msg.who && (uid ? msg.uid === uid : lc(msg.who) === lc(oldName))) msg.who = newName;
        if (msg.reply && lc(msg.reply.who) === lc(oldName)) msg.reply.who = newName;
      }
    }
  }

  $('ac-user-save').addEventListener('click', async () => {
    const name = $('ac-newuser').value.trim();
    if (!USER_RE.test(name)) return showMsg('ac-user-msg', 'Usernames are 3-20 letters, numbers, underscores or dots.');
    if (name === account.username) return showMsg('ac-user-msg', 'That is already your username.');
    $('ac-user-save').disabled = true;
    showMsg('ac-user-msg', '');
    try {
      const r = await api('/api/account/username', { token: account.token, body: { username: name } });
      renameEverywhere(account.username, r.username, myUid);
      account.username = r.username;
      remember('hideout.user', r.username);
      if (recallKeep()) saveSession();
      setText('ac-user', r.username);
      $('ac-newuser').value = '';
      showMsg('ac-user-msg', 'Your username is now @' + r.username + '.', true);
      refreshAll();
    } catch (err) {
      showMsg('ac-user-msg', err.message);
    } finally {
      $('ac-user-save').disabled = false;
    }
  });

  // Proof that it's really you: the current password (after a recovery-key login, nothing extra).
  async function reauthMaterial() {
    if (account.method === 'recovery') return {};
    const cur = $('ac-cur').value;
    if (!cur) throw new Error('Enter your current password first.');
    const { salt } = await api('/api/salt', { body: { username: account.username, method: 'password' } });
    const d = await SC.deriveAccount(cur, salt);
    return { currentAuth: d.auth, currentKey: d.key };
  }

  // Older accounts keyed the profile by the password directly; the first change upgrades them.
  async function masterForUpdate() {
    if (account.masterRaw) return { raw: account.masterRaw, pending: null, blob: undefined };
    const m = await SC.newMasterKey();
    return { raw: m.raw, pending: m, blob: await sealProfile(m.key, account.profile, account.idk) };
  }
  function commitMaster(pending) {
    if (pending) { account.masterRaw = pending.raw; account.key = pending.key; account.legacy = false; }
    if (recallKeep()) saveSession();
  }
  const recallKeep = () => recall('hideout.keep') === '1';

  // ---------- appearance + devices ----------
  function fillLook() {
    $('ap-theme').value = look.theme;
    $('ap-accent').value = /^#[0-9a-f]{6}$/i.test(look.accent) ? look.accent : '#6c8cff';
    $('ap-size').value = String(look.size);
    $('ap-density').value = look.density;
    $('ap-24h').checked = look.h24;
    $('ap-joins').checked = look.joins;
    $('ap-motion').checked = look.motion;
    $('ap-volume').value = String(look.volume);
    $('st-state').value = myStatus.state;
    $('st-text').value = myStatus.text;
    $('st-typing').checked = look.typing;
    $('nt-mode').value = look.notify;
    $('vc-ptt').checked = look.ptt;
    $('vc-key').textContent = 'Key: ' + (look.pttKey === ' ' ? 'Space' : look.pttKey.toUpperCase());
    $('ac-admin-wrap').hidden = !account.admin;
    setText('ac-del-msg', '');
    renderBlocked();
    fillMics();
    fillDesktop();
  }
  const bindLook = (id, key, get) => $(id).addEventListener('change', () => { look[key] = get($(id)); saveLook(); if (joined) redraw(); });
  bindLook('ap-theme', 'theme', (e) => e.value);
  bindLook('ap-size', 'size', (e) => Number(e.value));
  bindLook('ap-density', 'density', (e) => e.value);
  bindLook('ap-24h', 'h24', (e) => e.checked);
  bindLook('ap-joins', 'joins', (e) => e.checked);
  bindLook('ap-motion', 'motion', (e) => e.checked);
  $('ap-accent').addEventListener('input', () => { look.accent = $('ap-accent').value; saveLook(); });
  $('ap-accent-reset').addEventListener('click', () => { look.accent = ''; saveLook(); fillLook(); });
  $('ap-volume').addEventListener('change', () => { look.volume = Number($('ap-volume').value); saveLook(); beep(); });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyLook);
  $('ac-others').addEventListener('click', async () => {
    try { await api('/api/account/logout-others', { token: account.token }); showMsg('ac-dev-msg', 'Other devices were logged out.', true); }
    catch (err) { showMsg('ac-dev-msg', err.message); }
  });

  // ---------- people: nickname, block, volume ----------
  function popoverExtras(username, pid) {
    const uid = uidOfName(username);
    if (!uid) return;
    const wrap = el('div');
    wrap.style.padding = '4px 6px 0';
    wrap.append(el('label', '', 'Nickname (only you see it)'));
    const nick = el('input');
    nick.maxLength = 32;
    nick.value = nicks[uid] || '';
    nick.addEventListener('change', () => {
      const v = strip(nick.value).trim().slice(0, 32);
      if (v) nicks[uid] = v; else delete nicks[uid];
      jset('hideout.nick', nicks);
      redraw();
    });
    wrap.append(nick);
    if (pid && peers.get(pid) && peers.get(pid).voice) {
      wrap.append(el('label', '', 'Their voice volume'));
      const r = el('input');
      r.type = 'range'; r.min = '0'; r.max = '100'; r.step = '5';
      r.value = String(vols[uid] === undefined ? 100 : vols[uid]);
      r.addEventListener('input', () => { vols[uid] = Number(r.value); jset('hideout.vol', vols); applyAudioPrefs(); });
      wrap.append(r);
    }
    const b = el('button', blocked[uid] ? '' : 'danger', blocked[uid] ? 'Unblock' : 'Block');
    b.type = 'button';
    b.style.marginTop = '12px';
    b.addEventListener('click', () => {
      if (blocked[uid]) delete blocked[uid]; else blocked[uid] = username;
      jset('hideout.blocked', blocked);
      applyAudioPrefs();
      closeModal('popover');
      if (joined) redraw();
    });
    wrap.append(b);
    wrap.append(el('p', 'note', 'Blocking hides their messages and mutes their voice for you. They are not told.'));
    $('pop-body').append(wrap);
  }
  function renderBlocked() {
    const box = $('ac-blocked');
    box.textContent = '';
    const list = Object.entries(blocked);
    if (!list.length) box.append(el('p', 'note', 'Nobody. Block someone from their profile card.'));
    for (const [uid, name] of list) {
      const row = el('div', 'banrow');
      row.append(el('span', '', '@' + name));
      const u = el('button', '', 'Unblock');
      u.type = 'button';
      u.addEventListener('click', () => { delete blocked[uid]; jset('hideout.blocked', blocked); applyAudioPrefs(); renderBlocked(); if (joined) redraw(); });
      row.append(u);
      box.append(row);
    }
  }

  // ---------- status, voice and notification settings ----------
  async function fillMics() {
    const sel = $('vc-mic');
    sel.textContent = '';
    sel.add(new Option('Default', ''));
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      for (const d of devs) if (d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default') sel.add(new Option(d.label || 'Microphone ' + (sel.options.length), d.deviceId));
    } catch { /* no device list */ }
    sel.value = [...sel.options].some((o) => o.value === look.mic) ? look.mic : '';
  }
  $('vc-mic').addEventListener('change', () => { look.mic = $('vc-mic').value; saveLook(); switchMic(); });
  $('vc-ptt').addEventListener('change', () => { look.ptt = $('vc-ptt').checked; pttDown = false; saveLook(); applyTalk(); syncDesk(); });
  $('vc-key').addEventListener('click', () => {
    setText('vc-key-note', 'Press the key you want…');
    const once = (e) => { e.preventDefault(); e.stopPropagation(); look.pttKey = e.key.toLowerCase(); saveLook(); syncDesk(); $('vc-key').textContent = 'Key: ' + (e.key === ' ' ? 'Space' : e.key.toUpperCase()); setText('vc-key-note', ''); };
    document.addEventListener('keydown', once, { once: true, capture: true });
  });
  $('nt-mode').addEventListener('change', () => { look.notify = $('nt-mode').value; saveLook(); });
  $('st-typing').addEventListener('change', () => { look.typing = $('st-typing').checked; saveLook(); });
  const saveStatus = () => {
    myStatus = { state: $('st-state').value, text: strip($('st-text').value).trim().slice(0, 60) };
    jset('hideout.status', myStatus);
    broadcastStatus();
  };
  $('st-state').addEventListener('change', saveStatus);
  $('st-text').addEventListener('change', saveStatus);

  // ---------- invite link, export, delete account, admin ----------
  $('invite').addEventListener('click', async () => {
    const url = location.origin + '/#room=' + encodeURIComponent(room);
    try { await navigator.clipboard.writeText(url); pushSys(active, 'Invite link copied. Friends still need the room passphrase, so send that separately.'); }
    catch { pushSys(active, 'Copy this link: ' + url); }
  });

  $('rs-export').addEventListener('click', () => {
    const lines = ['Hideout export of #' + room + ' (' + new Date().toLocaleString() + ')', 'Only messages loaded in this window are included.', ''];
    for (const c of convs.values()) {
      const msgs = c.msgs.filter((m) => m.cls === 'chat');
      if (!msgs.length) continue;
      lines.push('=== ' + (c.kind === 'ch' ? '#' : 'DM with ') + c.name + ' ===');
      for (const m of msgs) {
        let t = '[' + new Date(m.ts).toLocaleString() + '] ' + m.who + ': ' + m.body;
        if (m.poll) t += ' [poll: ' + m.poll.q + ' | ' + m.poll.opts.join(' / ') + ']';
        if (m.file) t += ' [file: ' + m.file.name + ']';
        lines.push(t);
      }
      lines.push('');
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    a.download = 'hideout-' + room + '.txt';
    document.body.append(a);
    a.click();
    a.remove();
  });

  $('ac-delete').addEventListener('click', async () => {
    showMsg('ac-del-msg', '');
    if (!window.confirm('Delete your account for good? Your messages and DMs will be removed.')) return;
    try {
      const { currentAuth } = await reauthMaterial();
      await api('/api/account/delete', { token: account.token, body: { currentAuth } });
      await forgetDevice();
      location.reload();
    } catch (err) { showMsg('ac-del-msg', err.message); }
  });

  async function openAdmin() {
    setText('ad-err', '');
    try {
      const o = await api('/api/admin/overview', { token: account.token, body: {} });
      const fill = (box, rows, cols, del) => {
        box.textContent = '';
        const t = el('table', 'adm');
        for (const r of rows) {
          const tr = el('tr');
          for (const c of cols(r)) tr.append(el('td', '', c));
          const td = el('td');
          const b = el('button', 'danger', 'Remove');
          b.type = 'button';
          b.addEventListener('click', async () => {
            if (!window.confirm('Remove ' + del.label(r) + '? This can\'t be undone.')) return;
            try { await api(del.path, { token: account.token, body: del.body(r) }); openAdmin(); } catch (err) { setText('ad-err', err.message); }
          });
          td.append(b);
          tr.append(td);
          t.append(tr);
        }
        box.append(t);
      };
      const day = (ts) => new Date(ts).toLocaleDateString();
      fill($('ad-accounts'), o.accounts, (a) => ['@' + a.username + (a.admin ? ' (admin)' : ''), 'joined ' + day(a.created), a.online ? 'online' : ''],
        { path: '/api/admin/delete-account', body: (a) => ({ username: a.username }), label: (a) => '@' + a.username });
      fill($('ad-rooms'), o.rooms, (r) => ['# ' + r.name, r.members + ' members, ' + r.online + ' online', r.channels + ' channels', (r.fileBytes / 1048576).toFixed(1) + ' MB files', 'last used ' + day(r.lastUsed)],
        { path: '/api/admin/delete-room', body: (r) => ({ name: r.name }), label: (r) => '#' + r.name });
      openModal('adminmodal', 'ad-close');
    } catch (err) { showMsg('ac-del-msg', err.message); }
  }
  $('ac-admin').addEventListener('click', () => { closeModal('account'); openAdmin(); });
  $('ad-close').addEventListener('click', () => closeModal('adminmodal'));

  // ---------- notification settings ----------
  $('ac-sound').addEventListener('change', () => {
    prefs.sound = $('ac-sound').checked;
    remember('hideout.sound', prefs.sound ? '1' : '0');
    if (prefs.sound) beep();
  });
  $('ac-desktop').addEventListener('change', async () => {
    setText('ac-notify-msg', '');
    if (!$('ac-desktop').checked) { prefs.desktop = false; remember('hideout.desktop', '0'); return; }
    let perm = 'denied';
    try { perm = typeof Notification === 'undefined' ? 'denied' : (Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission); } catch { /* old browsers */ }
    prefs.desktop = perm === 'granted';
    $('ac-desktop').checked = prefs.desktop;
    remember('hideout.desktop', prefs.desktop ? '1' : '0');
    if (!prefs.desktop) setText('ac-notify-msg', 'Your browser blocked notifications. Allow them for this site in its settings, then try again.');
  });

  $('ac-pw-save').addEventListener('click', async () => {
    const np = $('ac-new').value;
    if (np.length < 8) return showMsg('ac-pw-msg', 'Use a password of at least 8 characters.');
    if (np !== $('ac-new2').value) return showMsg('ac-pw-msg', "Those passwords don't match.");
    $('ac-pw-save').disabled = true;
    showMsg('ac-pw-msg', '');
    try {
      const { currentAuth } = await reauthMaterial();
      const m = await masterForUpdate();
      const salt = SC.randomSalt();
      const d = await SC.deriveAccount(np, salt);
      await api('/api/account/password', { token: account.token, body: {
        currentAuth, salt, auth: d.auth, wrap: await SC.wrapMaster(d.key, m.raw), blob: m.blob,
      } });
      commitMaster(m.pending);
      account.passwordChanged = true;
      for (const id of ['ac-cur', 'ac-new', 'ac-new2']) $(id).value = '';
      showMsg('ac-pw-msg', 'Password changed. Your other logins were signed out.', true);
      refreshAll();
    } catch (err) {
      showMsg('ac-pw-msg', err.message);
    } finally {
      $('ac-pw-save').disabled = false;
    }
  });

  $('ac-rk-gen').addEventListener('click', async () => {
    $('ac-rk-gen').disabled = true;
    showMsg('ac-rk-msg', '');
    try {
      const { currentAuth, currentKey } = await reauthMaterial();
      const m = await masterForUpdate();
      const recoveryKey = SC.generateRecoveryKey();
      const salt = SC.randomSalt();
      const d = await SC.deriveAccount(SC.normalizeRecoveryKey(recoveryKey), salt);
      const body = { currentAuth, salt, auth: d.auth, wrap: await SC.wrapMaster(d.key, m.raw) };
      if (m.pending) {
        body.blob = m.blob;
        body.pwWrap = await SC.wrapMaster(currentKey, m.raw); // the password must open the new master key too
      }
      await api('/api/account/recovery', { token: account.token, body });
      commitMaster(m.pending);
      account.hasRecovery = true;
      setText('ac-rk-status', 'A recovery key is set. Making a new one replaces the old one.');
      $('ac-cur').value = '';
      showRecoveryKey(recoveryKey);
    } catch (err) {
      showMsg('ac-rk-msg', err.message);
    } finally {
      $('ac-rk-gen').disabled = false;
    }
  });

  // ---------- recovery key dialog (shown once) ----------
  function showRecoveryKey(recoveryKey) {
    setText('rk-value', recoveryKey);
    $('rk-ok').checked = false;
    $('rk-done').disabled = true;
    setText('rk-copy-msg', '');
    openModal('rkey', 'rk-copy');
  }
  $('rk-ok').addEventListener('change', () => { $('rk-done').disabled = !$('rk-ok').checked; });
  $('rk-done').addEventListener('click', () => { setText('rk-value', ''); closeModal('rkey'); });
  $('rk-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('rk-value').textContent);
      setText('rk-copy-msg', 'Copied.');
    } catch {
      setText('rk-copy-msg', 'Could not copy automatically. Select the key and copy it by hand.');
    }
  });

  // ---------- conversations ----------
  // A conversation is a channel ('c:<id>') or a DM with one person ('d:<uid>').
  const chKey = (id) => 'c:' + id;
  const dmConvKey = (uid) => 'd:' + uid;
  const pairId = (uid) => [myUid, uid].sort().join('|');
  const scopeId = (conv) => (conv.kind === 'ch' ? 'ch|' + conv.id : 'dm|' + pairId(conv.id));
  // Each message is sealed against its own conversation and id, so the server can't move one elsewhere.
  const msgAad = (conv, id) => `msg|${room}|${scopeId(conv)}|${id}`;
  const reactAad = (conv, id, uid) => `react|${room}|${scopeId(conv)}|${id}|${uid}`;
  const fileAad = (conv) => `file|${room}|${scopeId(conv)}`;
  const convKeyOf = (conv) => (conv.kind === 'ch' ? roomKey : dmKeys.get(conv.id) || null);
  const scopeFields = (conv) => (conv.kind === 'ch' ? { ch: conv.id } : { to: conv.id });
  const cleanWho = (w) => (typeof w === 'string' && USER_RE.test(w) ? w : 'unknown');

  function ensureCh(id, name) {
    const k = chKey(id);
    if (!convs.has(k)) convs.set(k, { key: k, kind: 'ch', id, name, msgs: [], byId: new Map(), unread: 0, loaded: false });
    else if (name) convs.get(k).name = name;
    return convs.get(k);
  }
  function ensureDm(uid) {
    const k = dmConvKey(uid);
    if (!convs.has(k)) {
      convs.set(k, { key: k, kind: 'dm', id: uid, name: dispName(knownUsers.get(uid) || 'unknown'), msgs: [], byId: new Map(), unread: 0, loaded: false });
    }
    return convs.get(k);
  }
  const convUsername = (conv) => knownUsers.get(conv.id) || 'unknown';

  const sysMsg = (body) => ({ cls: 'sys', body, ts: Date.now() });
  function pushSys(convKey, body, soft) {
    const c = convs.get(convKey);
    if (!c || (soft && !look.joins)) return;
    c.msgs.push(sysMsg(body));
    if (convKey === active) drawMsg(c.msgs[c.msgs.length - 1]);
  }

  // Turns a stored/received record into something we can show. Returns null if it can't be opened.
  async function recToMsg(conv, rec) {
    const key = convKeyOf(conv);
    if (!key || !rec || typeof rec.id !== 'string') return null;
    let p;
    try { p = await SC.open(key, msgAad(conv, rec.id), rec.data); } catch { return null; }
    if (!p || typeof p.text !== 'string') return null;
    const who = cleanWho(rec.who);
    if (typeof rec.from === 'string') knownUsers.set(rec.from, who);
    const msg = {
      cls: 'chat', id: rec.id, uid: rec.from, who, body: strip(p.text, true).slice(0, 4000),
      ts: typeof rec.ts === 'number' ? rec.ts : Date.now(), mine: rec.from === myUid,
      edited: rec.edited || 0, reacts: new Map(), votes: new Map(), reply: null, file: null, poll: null, pinned: !!rec.pinned,
      threadOf: typeof p.thread === 'string' && /^[A-Za-z0-9+/_=-]{8,32}$/.test(p.thread) ? p.thread : null,
    };
    if (p.poll && typeof p.poll.q === 'string' && Array.isArray(p.poll.opts) && p.poll.opts.length >= 2 && p.poll.opts.length <= 6) {
      msg.poll = { q: strip(p.poll.q).slice(0, 200), opts: p.poll.opts.map((o) => strip(String(o)).slice(0, 80)) };
    }
    if (p.reply && typeof p.reply.id === 'string' && typeof p.reply.text === 'string') {
      msg.reply = { id: p.reply.id.slice(0, 32), who: cleanWho(p.reply.who), text: strip(p.reply.text).slice(0, 120) };
    }
    const f = p.file;
    if (f && typeof f.id === 'string' && f.id === rec.fid && typeof f.name === 'string' && typeof f.type === 'string' && Number.isFinite(f.size)) {
      msg.file = { id: f.id, name: strip(f.name).replace(/[\\/]/g, '_').slice(0, 80) || 'file', type: f.type.slice(0, 60), size: Math.max(0, f.size) };
    }
    if (rec.reacts && typeof rec.reacts === 'object') {
      for (const [uid, data] of Object.entries(rec.reacts)) await loadReaction(conv, msg, uid, data);
    }
    return msg;
  }

  async function loadReaction(conv, msg, uid, data) {
    const key = convKeyOf(conv);
    if (data === null) { msg.reacts.delete(uid); msg.votes.delete(uid); return; }
    try {
      const o = await SC.open(key, reactAad(conv, msg.id, uid), data);
      const list = Array.isArray(o.e) ? o.e.filter((x) => typeof x === 'string' && x.length && x.length <= 8).slice(0, 8) : [];
      if (list.length) msg.reacts.set(uid, list); else msg.reacts.delete(uid);
      if (msg.poll && Number.isInteger(o.vote) && o.vote >= 0 && o.vote < msg.poll.opts.length) msg.votes.set(uid, o.vote); else msg.votes.delete(uid);
    } catch { /* ignore a reaction we can't open */ }
  }

  function addMsg(conv, msg, live) {
    if (conv.byId.has(msg.id)) return;
    conv.msgs.push(msg);
    conv.byId.set(msg.id, msg);
    while (conv.msgs.length > 500) { const old = conv.msgs.shift(); if (old.id) conv.byId.delete(old.id); }
    const t = typingBy.get(conv.key);
    if (t && t.has(msg.uid)) { clearTimeout(t.get(msg.uid)); t.delete(msg.uid); renderTyping(); }
    if (conv.key === active) { if (!searchTerm || matchesSearch(msg)) drawMsg(msg); if (!document.hidden) markRead(conv); }
    if (live && !msg.mine && !blocked[msg.uid]) notifyIncoming(conv, msg);
  }

  // ---------- read markers (this device) ----------
  const readKey = () => 'hideout.read.' + room;
  function markRead(conv) { readTimes[conv.key] = Date.now(); jset(readKey(), readTimes); }

  function mergeHistory(conv, list) {
    const known = new Set(list.map((x) => x.id));
    const extra = conv.msgs.filter((x) => x.cls === 'sys' || !known.has(x.id));
    conv.msgs = [...list, ...extra].sort((a, b) => a.ts - b.ts).slice(-500);
    conv.byId = new Map(conv.msgs.filter((x) => x.id).map((x) => [x.id, x]));
    conv.loaded = true;
    if (conv.key === active) { renderLog(); $('log').scrollTop = $('log').scrollHeight; }
    else {
      const r = readTimes[conv.key] || 0;
      conv.divAt = r;
      if (r) { conv.unread = conv.msgs.filter((x) => x.cls === 'chat' && !x.mine && x.ts > r && !blocked[x.uid]).length; renderLists(); updateTitle(); }
    }
  }

  // ---------- text formatting (built from DOM nodes only, never HTML) ----------
  const isMe = (name) => !!account && (lc(name) === lc(account.username) || lc(name) === 'everyone' || lc(name) === 'room');
  const mentionsMe = (body) => /(?<![\w.])@([A-Za-z0-9_.]{3,20})/g.test(body) &&
    [...body.matchAll(/(?<![\w.])@([A-Za-z0-9_.]{3,20})/g)].some((m) => isMe(m[1].replace(/[.]+$/, '')));
  const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(~~[^~\n]+~~)|(https?:\/\/[^\s<>"']+)|((?<![\w.])@[A-Za-z0-9_.]{3,20})/g;
  function inlineRich(text, parent) {
    let last = 0, m;
    INLINE.lastIndex = 0;
    while ((m = INLINE.exec(text))) {
      if (m.index > last) parent.append(document.createTextNode(text.slice(last, m.index)));
      const t = m[0];
      if (m[1]) parent.append(el('code', '', t.slice(1, -1)));
      else if (m[2]) parent.append(el('strong', '', t.slice(2, -2)));
      else if (m[3]) parent.append(el('em', '', t.slice(1, -1)));
      else if (m[4]) parent.append(el('s', '', t.slice(2, -2)));
      else if (m[5]) {
        const url = t.replace(/[.,!?;:)]+$/, '');
        let ok = false;
        try {
          const u = new URL(url);
          if (u.protocol === 'http:' || u.protocol === 'https:') {
            const a = el('a', '', url);
            a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
            parent.append(a); ok = true;
          }
        } catch { /* not a link */ }
        if (!ok) parent.append(document.createTextNode(url));
        if (t.length > url.length) parent.append(document.createTextNode(t.slice(url.length)));
      } else if (m[6]) parent.append(el('span', 'mn' + (isMe(t.slice(1)) ? ' me' : ''), t));
      last = m.index + t.length;
    }
    if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
  }
  function renderRich(text, parent) {
    for (const part of text.split(/(```[\s\S]*?```)/g)) {
      if (part.length >= 6 && part.startsWith('```') && part.endsWith('```')) parent.append(el('pre', '', part.slice(3, -3).replace(/^\n/, '')));
      else inlineRich(part, parent);
    }
  }
  const matchesSearch = (msg) => {
    const t = searchTerm;
    return msg.body.toLowerCase().includes(t) || (msg.file && msg.file.name.toLowerCase().includes(t)) ||
      (msg.poll && msg.poll.q.toLowerCase().includes(t)) || dispName(msg.who).toLowerCase().includes(t);
  };

  // ---------- drawing messages ----------
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const isImageType = (t) => /^image\/(png|jpeg|gif|webp)$/.test(t);

  async function fetchFileUrl(conv, file) {
    if (blobCache.has(file.id)) return blobCache.get(file.id);
    const res = await fetch('/api/file/' + file.id, { headers: { Authorization: 'Bearer ' + account.token }, cache: 'no-store' });
    if (!res.ok) throw new Error('That file is gone.');
    const key = convKeyOf(conv);
    if (!key) throw new Error('Not ready yet.');
    const bytes = await SC.openBytes(key, fileAad(conv), await res.arrayBuffer());
    const url = URL.createObjectURL(new Blob([bytes], { type: isImageType(file.type) ? file.type : 'application/octet-stream' }));
    blobCache.set(file.id, url);
    return url;
  }

  function drawAttachment(msg, conv) {
    const f = msg.file;
    const box = el('div', 'att');
    if (isImageType(f.type) && f.size <= MAX_FILE) {
      const ph = el('div', 'ph', 'Loading image…');
      box.append(ph);
      const load = async () => {
        try {
          const url = await fetchFileUrl(conv, f);
          const img = document.createElement('img');
          img.alt = f.name;
          img.src = url;
          img.addEventListener('click', () => { $('viewer-img').src = url; $('viewer-img').alt = f.name; openModal('viewer', 'viewer-close'); });
          ph.replaceWith(img);
        } catch (err) { ph.textContent = 'Could not load image: ' + err.message; }
      };
      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((ents) => { if (ents.some((e) => e.isIntersecting)) { io.disconnect(); load(); } }, { root: $('log') });
        io.observe(box);
      } else load();
      return box;
    }
    const item = el('div', 'fileitem');
    const nm = el('span', 'fn', '📄 ' + f.name);
    const sz = el('span', 'fs', fmtSize(f.size));
    const dl = el('button', '', 'Download');
    dl.type = 'button';
    dl.addEventListener('click', async () => {
      dl.disabled = true;
      try {
        const url = await fetchFileUrl(conv, f);
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        document.body.append(a);
        a.click();
        a.remove();
      } catch (err) { dl.textContent = err.message; }
      dl.disabled = false;
    });
    item.append(nm, sz, dl);
    box.append(item);
    return box;
  }

  function drawPoll(msg, conv) {
    const box = el('div', 'poll');
    box.append(el('div', 'pq', '📊 ' + msg.poll.q));
    const counts = msg.poll.opts.map(() => 0);
    for (const v of msg.votes.values()) counts[v]++;
    const total = counts.reduce((a, b) => a + b, 0);
    const mine = msg.votes.get(myUid);
    msg.poll.opts.forEach((o, i) => {
      const b = el('button', 'popt' + (mine === i ? ' mine' : ''));
      b.type = 'button';
      const bar = el('div', 'bar');
      bar.style.width = (total ? Math.round(100 * counts[i] / total) : 0) + '%';
      b.append(bar, el('span', '', o + '  ·  ' + counts[i]));
      b.addEventListener('click', () => vote(conv, msg, i));
      box.append(b);
    });
    box.append(el('div', 'note', total + (total === 1 ? ' vote' : ' votes')));
    return box;
  }

  function drawReacts(msg, conv) {
    const counts = new Map();
    for (const list of msg.reacts.values()) for (const e of list) counts.set(e, (counts.get(e) || 0) + 1);
    const mine = new Set(msg.reacts.get(myUid) || []);
    const box = el('div', 'reacts');
    for (const [e, n] of counts) {
      const b = el('button', 'react' + (mine.has(e) ? ' mine' : ''), e + ' ' + n);
      b.type = 'button';
      b.addEventListener('click', () => toggleReact(conv, msg, e));
      box.append(b);
    }
    return box;
  }

  function buildActions(msg, conv, row) {
    const box = el('div', 'mact');
    for (const e of EMOJI) {
      const b = el('button', 'emo', e);
      b.type = 'button';
      b.setAttribute('aria-label', 'React with ' + e);
      b.addEventListener('click', () => toggleReact(conv, msg, e));
      box.append(b);
    }
    const pin = el('button', '', msg.pinned ? 'Unpin' : 'Pin');
    pin.type = 'button';
    pin.addEventListener('click', () => { msg.pinned = !msg.pinned; redraw(); wsSend({ type: 'pin', ...scopeFields(conv), id: msg.id, on: msg.pinned }); });
    box.append(pin);
    const th = el('button', '', 'Thread');
    th.type = 'button';
    th.addEventListener('click', () => openThread(conv, msg.threadOf && conv.byId.get(msg.threadOf) ? conv.byId.get(msg.threadOf) : msg));
    box.append(th);
    const isSaved = saved.some((x) => x.room === room && x.id === msg.id);
    const sv = el('button', '', isSaved ? 'Unsave' : 'Save');
    sv.type = 'button';
    sv.addEventListener('click', () => {
      saved = saved.filter((x) => !(x.room === room && x.id === msg.id));
      if (!isSaved) saved.unshift({ room, convKey: conv.key, id: msg.id, who: msg.who, text: (msg.body || (msg.poll ? msg.poll.q : msg.file ? msg.file.name : '')).slice(0, 140), at: Date.now() });
      jset('hideout.saved', saved.slice(0, 200));
      redraw();
    });
    box.append(sv);
    const reply = el('button', '', 'Reply');
    reply.type = 'button';
    reply.addEventListener('click', () => startReply(msg));
    box.append(reply);
    if (msg.mine) {
      const ed = el('button', '', 'Edit');
      ed.type = 'button';
      ed.addEventListener('click', () => startEdit(msg));
      box.append(ed);
    }
    if (msg.mine || (isOwner && conv.kind === 'ch')) {
      const del = el('button', '', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => {
        if (!window.confirm('Delete this message for everyone?')) return;
        deleteMsg(conv, msg);
      });
      box.append(del);
    }
    return box;
  }

  function drawMsg(msg) {
    const log = $('log');
    const conv = convs.get(active);
    if (msg.cls === 'chat' && blocked[msg.uid]) return;
    if (msg.cls === 'chat' && msg.threadOf && conv && conv.byId.has(msg.threadOf)) return;
    if (searchTerm && (msg.cls === 'sys' || !matchesSearch(msg))) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const row = document.createElement('div');

    if (msg.cls === 'sys') {
      row.className = 'msg sys';
      row.textContent = msg.body;
      lastDrawn = null;
    } else {
      const compact = !!lastDrawn && lastDrawn.cls === 'chat' && lastDrawn.uid === msg.uid && msg.ts - lastDrawn.ts < 5 * 60e3 && !msg.reply;
      row.className = 'msg' + (compact ? ' compact' : '') + (!msg.mine && mentionsMe(msg.body) ? ' mention' : '');
      row.dataset.id = msg.id;
      const content = el('div', 'content');
      if (compact) {
        row.append(el('div', 'gutter', fmtTime(msg.ts)));
      } else {
        row.append(makeAvatar(msg.who, 40, true));
        const head = el('div', 'head');
        const who = el('button', 'who', dispName(msg.who));
        who.type = 'button';
        who.addEventListener('click', () => openProfile(msg.who));
        head.append(who, el('span', 'time', fmtTime(msg.ts)));
        if (msg.uid === ownerUid) { const c = el('span', 'crown', '👑'); c.title = 'Room owner'; head.append(c); }
        if (msg.pinned) head.append(el('span', 'pinned-mark', '📌 pinned'));
        content.append(head);
      }
      if (msg.reply) {
        const r = el('button', 'replyref', '↩ ' + dispName(msg.reply.who) + ': ' + msg.reply.text);
        r.type = 'button';
        r.addEventListener('click', () => scrollToMsg(msg.reply.id));
        content.append(r);
      }
      if (msg.body) {
        const body = el('div', 'body');
        renderRich(msg.body, body); // built from text nodes and a few safe elements, never HTML
        if (msg.edited) body.append(el('span', 'edited', '(edited)'));
        content.append(body);
      }
      if (msg.poll) content.append(drawPoll(msg, conv));
      if (msg.file) content.append(drawAttachment(msg, conv));
      if (msg.reacts.size) content.append(drawReacts(msg, conv));
      const nrep = conv ? conv.msgs.filter((x) => x.threadOf === msg.id && !blocked[x.uid]).length : 0;
      if (nrep) {
        const tb = el('button', 'threadbtn', '💬 ' + nrep + (nrep === 1 ? ' reply' : ' replies'));
        tb.type = 'button';
        tb.addEventListener('click', () => openThread(conv, msg));
        content.append(tb);
      }
      row.append(content);

      const more = el('button', 'more', '⋯');
      more.type = 'button';
      more.setAttribute('aria-label', 'Message actions');
      more.addEventListener('click', () => {
        const open = row.classList.toggle('open');
        const existing = content.querySelector('.mact');
        if (existing) existing.remove();
        if (open) content.append(buildActions(msg, conv, row));
      });
      row.append(more);
      lastDrawn = msg;
    }
    log.append(row);
    if (nearBottom || msg.mine) log.scrollTop = log.scrollHeight;
  }

  function scrollToMsg(id) {
    const row = $('log').querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1500);
  }

  function renderLog() {
    $('log').textContent = '';
    lastDrawn = null;
    const c = convs.get(active);
    if (!c) return;
    let divDone = !(c.divAt > 0);
    for (const m of c.msgs) {
      if (!divDone && m.cls === 'chat' && !m.mine && m.ts > c.divAt && !blocked[m.uid]) { $('log').append(el('div', 'newline', 'NEW')); divDone = true; }
      drawMsg(m);
    }
  }

  // Re-draw after something changed, keeping the reader's place.
  function redraw() {
    const log = $('log');
    const fromBottom = log.scrollHeight - log.scrollTop;
    renderLog();
    log.scrollTop = log.scrollHeight - fromBottom;
    updateComposer();
    renderLists();
    renderThread();
    renderSelf();
    renderCallBar();
  }

  function showConv(convKey) {
    if (!convs.has(convKey)) return;
    active = convKey;
    const cv = convs.get(convKey);
    cv.unread = 0;
    cv.divAt = readTimes[convKey] || 0;
    markRead(cv);
    closeSearch();
    cancelCompose();
    $('msg').value = drafts[room + '|' + convKey] || '';
    renderLog();
    $('log').scrollTop = $('log').scrollHeight;
    updateComposer();
    renderLists();
    updateTitle();
  }

  function openConv(convKey) {
    if (convKey.startsWith('d:') && !convs.has(convKey)) ensureDm(convKey.slice(2));
    showConv(convKey);
    if (!$('msg').disabled) $('msg').focus();
  }

  function updateComposer() {
    const input = $('msg'), btn = $('send');
    const c = convs.get(active);
    if (!c) return;
    let ok = true;
    if (c.kind === 'ch') {
      input.placeholder = 'Message #' + c.name;
      setText('conv-title', '# ' + c.name);
      setText('conv-note', 'Everyone in the room. Saved encrypted so you can catch up later');
    } else {
      const online = !!peerIdForUid(c.id);
      ok = online && dmKeys.has(c.id);
      input.placeholder = ok ? 'Message ' + c.name : (online ? 'Setting up a secure channel…' : c.name + ' is not in the room');
      setText('conv-title', c.name);
      setText('conv-note', 'Private. Only you and ' + c.name + ' can read this. Saved encrypted');
    }
    input.disabled = !ok; btn.disabled = !ok;
    $('attach').disabled = !ok || (!roomSettings.allowFiles && !isOwner);
    renderConvActions();
  }

  function renderConvActions() {
    const box = $('conv-actions');
    box.textContent = '';
    const c = convs.get(active);
    if (!c) return;
    const mute = el('button', '', muted_.has(c.key) ? 'Unmute chat' : 'Mute chat');
    mute.type = 'button';
    mute.title = 'Silence sounds and notifications for this chat';
    mute.addEventListener('click', () => {
      if (muted_.has(c.key)) muted_.delete(c.key); else muted_.add(c.key);
      try { localStorage.setItem('hideout.muted.' + room, JSON.stringify([...muted_])); } catch { /* ignore */ }
      renderConvActions();
    });
    box.append(mute);
    const sb = el('button', '', 'Search');
    sb.type = 'button';
    sb.addEventListener('click', () => { $('searchbar').hidden = false; $('search-in').focus(); });
    const np = c.msgs.filter((m) => m.pinned).length;
    const pb = el('button', '', '📌 Pins' + (np ? ' (' + np + ')' : ''));
    pb.type = 'button';
    pb.addEventListener('click', openPins);
    box.append(sb, pb);
    if (c.kind !== 'dm') return;
    const clear = el('button', '', 'Clear history');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      if (!window.confirm('Delete this whole conversation for both of you? This can\'t be undone.')) return;
      c.msgs = []; c.byId = new Map();
      wsSend({ type: 'dm-clear', with: c.id });
      redraw();
    });
    box.append(clear);
    const pid = peerIdForUid(c.id);
    if (call && call.id === pid) {
      const b = el('button', '', call.state === 'in' ? 'Decline' : 'Hang up');
      b.type = 'button';
      b.addEventListener('click', hangUp);
      box.append(b);
    } else if (pid && !call) {
      const b = el('button', '', 'Call');
      b.type = 'button';
      b.disabled = !dmKeys.has(c.id);
      b.addEventListener('click', () => placeCall(pid));
      box.append(b);
    }
  }

  // ---------- lists ----------
  function voiceLabel(p) {
    const c = p.conns && p.conns.room;
    if (!c || c.state === 'connecting' || c.state === 'new') return 'connecting…';
    if (c.state === 'failed') return 'voice failed';
    return 'voice';
  }

  function addBadges(parent, entry, c) {
    if (entry.owner) { const w = el('span', 'crown', '👑'); w.title = 'Room owner'; parent.append(w); }
    if (entry.voice) parent.append(el('span', 'badge', entry.voiceText || 'voice'));
    if (c && c.unread > 0) parent.append(el('span', 'unread', String(c.unread)));
  }

  function buildItem(entry, kind) {
    const c = convs.get(entry.key);
    const isActive = entry.key === active;
    const label = entry.label + (entry.offline ? ' (left)' : '');

    if (kind === 'tab') {
      const b = el('button', 'tab' + (isActive ? ' active' : '') + (entry.offline ? ' off' : ''));
      b.type = 'button';
      if (entry.username) b.append(makeAvatar(entry.username, 24, false));
      b.append(el('span', 'nm', (entry.username ? '' : '# ') + label));
      addBadges(b, entry, c);
      b.addEventListener('click', () => openConv(entry.key));
      return b;
    }

    const row = el('div', 'item-row' + (isActive ? ' active' : '') + (entry.offline ? ' off' : ''));
    if (entry.username) row.append(makeAvatar(entry.username, 32, true));
    else row.append(el('span', 'group-icon', '#'));
    const b = el('button', 'item-main');
    b.type = 'button';
    const nm = el('span', 'nm');
    if (entry.status) { const d = el('span', 'statusdot ' + entry.status.state); nm.append(d); }
    nm.append(document.createTextNode(label));
    b.append(nm);
    if (entry.status && entry.status.text) b.title = entry.status.text;
    addBadges(b, entry, c);
    if (entry.status && entry.status.text) row.title = entry.status.text;
    b.addEventListener('click', () => openConv(entry.key));
    row.append(b);
    return row;
  }

  function renderLists() {
    if (!joined) return;
    const chans = [];
    for (const c of convs.values()) if (c.kind === 'ch') chans.push({ key: c.key, label: c.name });
    chans.sort((a, b) => (a.key === chKey('general') ? -1 : b.key === chKey('general') ? 1 : 0));

    const people = [];
    for (const [id, p] of peers) {
      const label = dispName(p.username);
      const c = convs.get(dmConvKey(p.uid));
      if (c) c.name = label;
      people.push({ key: dmConvKey(p.uid), label, username: p.username, voice: p.voice || (call && call.id === id && call.state === 'on'),
        voiceText: call && call.id === id ? 'call' : voiceLabel(p), owner: p.uid === ownerUid, status: p.status || { state: 'online', text: '' } });
    }
    for (const c of convs.values()) {
      if (c.kind === 'dm' && !peerIdForUid(c.id) && c.msgs.some((m) => m.cls === 'chat')) {
        people.push({ key: c.key, label: c.name, username: convUsername(c), offline: true });
      }
    }

    convOrder = [...chans, ...people].map((e) => e.key);
    const fill = (ul, list) => {
      ul.textContent = '';
      for (const entry of list) { const li = document.createElement('li'); li.append(buildItem(entry, 'item')); ul.append(li); }
    };
    fill($('channels'), chans);
    fill($('members'), people);
    const tabs = $('tabs');
    tabs.textContent = '';
    for (const entry of [...chans, ...people]) tabs.append(buildItem(entry, 'tab'));
    const add = el('button', 'tab', '+');
    add.type = 'button';
    add.setAttribute('aria-label', 'New channel');
    add.addEventListener('click', openNewChannel);
    tabs.append(add);
    setText('count', String(peers.size + 1));
    $('room-settings').hidden = false;
  }

  function renderSelf() {
    const me = $('me');
    me.textContent = '';
    const info = el('button', 'me-info');
    info.type = 'button';
    info.setAttribute('aria-label', 'View your profile');
    info.append(makeAvatar(account.username, 40, false));
    const t = el('div', 'me-text');
    t.append(el('span', 'me-name', account.profile.displayName));
    t.append(el('span', 'me-user', call && call.state === 'on' ? 'in a call' : voiceOn ? (muted ? 'in voice (muted)' : 'in voice') : '@' + account.username));
    info.append(t);
    info.addEventListener('click', () => openProfile(account.username));
    const edit = el('button', 'gear', 'Edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', 'Edit profile');
    edit.addEventListener('click', openEditor);
    const gear = el('button', 'gear', '⚙');
    gear.type = 'button';
    gear.setAttribute('aria-label', 'Settings');
    gear.addEventListener('click', openAccount);
    me.append(info, edit, gear);
  }

  // ---------- notifications ----------
  let audioCtx = null;
  function getAC() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch { return null; }
    return audioCtx;
  }
  document.addEventListener('click', () => { const ac = getAC(); if (ac && ac.state === 'suspended') ac.resume().catch(() => {}); });

  function beep(freq = 880) {
    const ac = getAC();
    if (!ac) return;
    try {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(Math.max(0.001, 0.25 * (look.volume / 100)), ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.25);
      o.connect(g).connect(ac.destination);
      o.start();
      o.stop(ac.currentTime + 0.27);
    } catch { /* sound is a nicety */ }
  }

  function updateTitle() {
    let n = 0;
    for (const c of convs.values()) n += c.unread;
    document.title = (n ? '(' + n + ') ' : '') + 'Hideout';
    if (desk && desk.setBadge) desk.setBadge(n);
  }

  function desktopNotify(title, body, tag) {
    if (!prefs.desktop || !document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(title, { body, tag, icon: undefined });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* some mobile browsers only allow service-worker notifications */ }
  }

  function notifyIncoming(conv, msg) {
    const viewing = conv.key === active && !document.hidden;
    if (viewing) return;
    conv.unread++;
    renderLists();
    updateTitle();
    if (muted_.has(conv.key) || myStatusNow().state === 'dnd') return;
    if (conv.kind === 'ch' && look.notify === 'mentions' && !mentionsMe(msg.body)) return;
    if (prefs.sound) beep();
    const title = dispName(msg.who) + (conv.kind === 'ch' ? ' in #' + conv.name : '');
    desktopNotify(title, msg.body ? msg.body.slice(0, 120) : 'Sent a file', conv.key);
  }

  document.addEventListener('visibilitychange', () => {
    clearTimeout(awayTimer);
    if (document.hidden) awayTimer = setTimeout(() => { autoAway = true; broadcastStatus(); }, 5 * 60e3);
    else if (autoAway) { autoAway = false; broadcastStatus(); }
    if (!document.hidden && joined) {
      const c = convs.get(active);
      if (c) { c.unread = 0; markRead(c); }
      renderLists();
      updateTitle();
    }
  });

  // ---------- join a room ----------
  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setText('home-err', '');
    const r = $('room').value.trim().toLowerCase();
    const pass = $('pass').value;
    if (!r) return setText('home-err', 'Enter a room name.');
    if (pass.length < 8) return setText('home-err', 'Use a passphrase of at least 8 characters.');
    if (!secureOk()) return setText('home-err', 'This page needs HTTPS (or localhost) for encryption to work.');
    $('join-go').disabled = true;
    $('join-go').textContent = 'Deriving keys…';
    try {
      const d = await SC.derive(r, pass);
      if ($('keep-room').checked) await rememberRoom(r, d);
      await startJoin(r, d);
    } catch (err) {
      setText('home-err', 'Could not set up encryption: ' + err.message);
      resetJoinButton();
    }
  });

  async function startJoin(r, d) {
    setText('home-err', '');
    $('join-go').disabled = true;
    roomKey = d.key;
    room = r;
    remember('hideout.room', r);
    await loadIce();
    connect(d.auth);
  }

  function resetJoinButton() {
    $('join-go').disabled = false;
    $('join-go').textContent = 'Join';
  }

  function connect(auth) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsQueue = Promise.resolve();
    ws.onopen = () => wsSend({ type: 'join', room, token: account.token, auth });
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      // One at a time and in order: decrypting is async, and history/edits must apply in sequence.
      wsQueue = wsQueue.then(() => onMsg(m)).catch(() => {});
    };
    ws.onclose = () => {
      if (joined) {
        $('banner').hidden = false;
        setText('banner-text', endedReason || 'Disconnected from the server.');
        stopVoice(false);
        endCall('');
      } else if (!$('home-err').textContent) {
        setText('home-err', 'Could not reach the server.');
        resetJoinButton();
      }
    };
  }

  function leaveRoom() {
    flushDeletes();
    closeThread();
    stopVoice(false);
    stopShare();
    typingBy.clear(); closeSearch(); readTimes = {};
    endCall('');
    releaseMicIfIdle();
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch { /* ignore */ } ws = null; }
    for (const id of [...peers.keys()]) closePeerConn(id);
    peers.clear(); convs.clear(); dmKeys.clear(); knownUsers.clear(); speaking.clear();
    for (const u of blobCache.values()) URL.revokeObjectURL(u);
    blobCache.clear();
    for (const k of [...profiles.keys()]) if (k !== lc(account.username)) profiles.delete(k);
    joined = false; roomKey = null; myId = ''; myUid = ''; ownerUid = ''; isOwner = false; bans = [];
    active = ''; lastDrawn = null; endedReason = ''; pendingFile = null;
    cancelCompose();
    setPending(null);
    $('log').textContent = '';
    $('banner').hidden = true;
    $('pass').value = '';
    updateTitle();
    resetJoinButton();
    showScreen('home');
    renderHome();
  }
  $('leave').addEventListener('click', leaveRoom);
  $('banner-btn').addEventListener('click', leaveRoom);

  function newPeer(p) {
    return {
      uid: p.uid, username: cleanWho(p.name), voice: !!p.voice, conns: {}, audio: null, status: { state: 'online', text: '' },
      out: Promise.resolve(), inq: Promise.resolve(), dmQueue: [],
    };
  }

  async function addChannel(c) {
    if (!c || typeof c.id !== 'string' || !/^[a-f0-9]{10}$/.test(c.id)) return null;
    let name = 'channel';
    try {
      const o = await SC.open(roomKey, 'chname|' + room, c.data);
      if (o && typeof o.name === 'string') name = strip(o.name).trim().slice(0, 24) || name;
    } catch { /* keep the placeholder name */ }
    return ensureCh(c.id, name);
  }

  function rejoinNote(text) { endedReason = text; }

  async function onMsg(m) {
    switch (m.type) {
      case 'error':
        setText('home-err', m.message || 'Could not join.');
        resetJoinButton();
        break;
      case 'replaced':
        rejoinNote('You joined this room from another tab or device, so this one was disconnected.');
        break;
      case 'signed-out':
        rejoinNote('Your password was changed somewhere else, so this login was signed out.');
        forgetDevice();
        break;
      case 'kicked':
        rejoinNote(m.banned ? 'The room owner banned you from this room.' : 'The room owner removed you from this room.');
        break;
      case 'renamed': {
        const p = peers.get(m.id);
        if (!p || typeof m.name !== 'string' || !USER_RE.test(m.name)) break;
        renameEverywhere(p.username, m.name, p.uid);
        p.username = m.name;
        redraw();
        break;
      }
      case 'joined': await onJoined(m); break;
      case 'peer-joined':
        if (typeof m.id !== 'string' || typeof m.uid !== 'string') break;
        peers.set(m.id, newPeer({ uid: m.uid, name: m.name }));
        knownUsers.set(m.uid, cleanWho(m.name));
        pushSys(chKey('general'), dispName(cleanWho(m.name)) + ' joined', true);
        updateComposer();
        renderLists();
        break;
      case 'peer-left': {
        const p = peers.get(m.id);
        if (!p) break;
        if (call && call.id === m.id) endCall(dispName(p.username) + ' left.');
        closePeerConn(m.id);
        peers.delete(m.id);
        pushSys(chKey('general'), dispName(p.username) + ' left', true);
        if (convs.has(dmConvKey(p.uid))) pushSys(dmConvKey(p.uid), dispName(p.username) + ' left the room', true);
        updateComposer();
        renderLists();
        break;
      }
      case 'voice-state': {
        const p = peers.get(m.id);
        if (!p) break;
        p.voice = !!m.on;
        if (!p.voice) closeConn(m.id, 'room');
        renderLists();
        break;
      }
      case 'voice-peers':
        if (voiceOn && Array.isArray(m.ids)) for (const id of m.ids) dial(id, 'room').catch(() => {});
        break;
      case 'channel': {
        const c = await addChannel(m);
        if (c) { c.loaded = true; renderLists(); }
        break;
      }
      case 'channel-gone': {
        const k = chKey(m.id);
        if (m.id === 'general' || !convs.has(k)) break;
        convs.delete(k);
        if (active === k) showConv(chKey('general'));
        renderLists();
        renderRoomSettings();
        break;
      }
      case 'room-settings':
        if (m.settings && typeof m.settings === 'object') { roomSettings = { ...roomSettings, ...m.settings }; renderRoomSettings(); updateComposer(); renderLists(); }
        break;
      case 'dm-cleared': {
        const c = typeof m.dm === 'string' ? convs.get(dmConvKey(m.dm)) : null;
        if (c) { c.msgs = []; c.byId = new Map(); pushSys(c.key, dispName(convUsername(c)) + ' cleared this conversation.'); if (c.key === active) redraw(); }
        break;
      }
      case 'bans':
        if (isOwner && Array.isArray(m.bans)) { bans = m.bans; renderRoomSettings(); }
        break;
      case 'history': {
        const conv = convs.get(chKey(m.ch));
        if (conv) await loadHistory(conv, m.items);
        break;
      }
      case 'dm-history': {
        if (typeof m.with !== 'string') break;
        await loadHistory(ensureDm(m.with), m.items);
        break;
      }
      case 'chat': {
        const conv = convs.get(chKey(m.ch));
        if (!conv || !m.rec) break;
        const msg = await recToMsg(conv, m.rec);
        if (msg) addMsg(conv, msg, true);
        break;
      }
      case 'dm': await onDm(m); break;
      case 'edit': case 'del': case 'react': case 'pin': await onMutation(m); break;
      case 'typing': onTyping(m); break;
      case 'signal': onSignal(m); break;
    }
  }

  async function onJoined(m) {
    if (typeof m.id !== 'string' || typeof m.uid !== 'string' || !Array.isArray(m.peers)) return;
    joined = true;
    myId = m.id;
    myUid = m.uid;
    ownerUid = typeof m.owner === 'string' ? m.owner : '';
    isOwner = ownerUid === myUid;
    bans = isOwner && Array.isArray(m.bans) ? m.bans : [];
    if (m.settings) roomSettings = { ...roomSettings, ...m.settings };
    try { muted_ = new Set(JSON.parse(localStorage.getItem('hideout.muted.' + room) || '[]')); } catch { muted_ = new Set(); }
    readTimes = jget(readKey(), {});
    knownUsers.set(myUid, account.username);
    for (const p of m.peers) { if (typeof p.id === 'string' && typeof p.uid === 'string') { peers.set(p.id, newPeer(p)); knownUsers.set(p.uid, cleanWho(p.name)); } }
    ensureCh('general', 'general');
    for (const c of Array.isArray(m.channels) ? m.channels : []) await addChannel(c);
    showScreen('app');
    setText('room-title', '# ' + room);
    renderSelf();
    showConv(chKey('general'));
    pushSys(chKey('general'), 'You joined. Messages are end-to-end encrypted, and the server keeps them only in encrypted form.');
    for (const c of convs.values()) if (c.kind === 'ch') wsSend({ type: 'history', ch: c.id });
    // Swap DM public keys with everyone already here (sealed with the room key).
    for (const id of peers.keys()) queueSignal(id, { kind: 'hello', pub: account.idPub, reply: true });
    $('msg').focus();
  }

  async function loadHistory(conv, items) {
    if (!Array.isArray(items)) return;
    const list = [];
    let bad = 0;
    for (const rec of items) {
      const msg = await recToMsg(conv, rec);
      if (msg) list.push(msg); else bad++;
    }
    mergeHistory(conv, list);
    if (bad) pushSys(conv.key, bad + ' older message' + (bad > 1 ? 's' : '') + " couldn't be opened.");
  }

  async function onDm(m) {
    const rec = m.rec;
    if (!rec || typeof rec.from !== 'string') return;
    const pid = peerIdForUid(rec.from);
    const p = pid && peers.get(pid);
    if (!dmKeys.has(rec.from)) { if (p) p.dmQueue.push(m); return; } // their hello hasn't been processed yet
    const conv = ensureDm(rec.from);
    const msg = await recToMsg(conv, rec);
    if (msg) addMsg(conv, msg, true);
  }

  // Edits, deletes and reactions.
  async function onMutation(m) {
    const conv = m.ch ? convs.get(chKey(m.ch)) : (typeof m.dm === 'string' ? ensureDm(m.dm) : null);
    if (!conv || typeof m.id !== 'string') return;
    const msg = conv.byId.get(m.id);
    if (!msg) return;
    if (m.type === 'del') {
      conv.msgs = conv.msgs.filter((x) => x !== msg);
      conv.byId.delete(msg.id);
      if (editing === msg || (replyTo && replyTo.id === msg.id)) cancelCompose();
    } else if (m.type === 'edit') {
      const key = convKeyOf(conv);
      try {
        const p = await SC.open(key, msgAad(conv, msg.id), m.data);
        if (typeof p.text !== 'string') return;
        msg.body = strip(p.text, true).slice(0, 4000);
        msg.edited = typeof m.edited === 'number' ? m.edited : Date.now();
      } catch { return; }
    } else if (m.type === 'react') {
      if (typeof m.uid !== 'string') return;
      await loadReaction(conv, msg, m.uid, m.data);
    } else if (m.type === 'pin') {
      msg.pinned = m.on === true;
    }
    if (conv.key === active) redraw();
  }

  // ---------- status ----------
  const myStatusNow = () => {
    const text = look.autoGame && gameName ? 'Playing ' + gameName : myStatus.text;
    return { state: autoAway && myStatus.state === 'online' ? 'away' : myStatus.state, text };
  };
  function broadcastStatus() {
    if (!joined) return;
    const st = myStatusNow();
    for (const id of peers.keys()) queueSignal(id, { kind: 'status', state: st.state, text: st.text });
    renderSelf();
  }

  // ---------- typing ----------
  function onTyping(m) {
    if (!look.typing || typeof m.uid !== 'string' || blocked[m.uid] || m.uid === myUid) return;
    const key = m.ch ? chKey(m.ch) : (typeof m.dm === 'string' ? dmConvKey(m.dm) : null);
    if (!key || !convs.has(key)) return;
    if (!typingBy.has(key)) typingBy.set(key, new Map());
    const t = typingBy.get(key);
    clearTimeout(t.get(m.uid));
    t.set(m.uid, setTimeout(() => { t.delete(m.uid); renderTyping(); }, 5000));
    renderTyping();
  }
  function renderTyping() {
    const t = typingBy.get(active);
    const names = t ? [...t.keys()].map((u) => dispName(knownUsers.get(u) || 'someone')) : [];
    setText('typing', !names.length ? '' : names.length === 1 ? names[0] + ' is typing…' : names.length === 2 ? names.join(' and ') + ' are typing…' : 'Several people are typing…');
  }
  let draftTimer = null;
  $('msg').addEventListener('input', () => {
    if (!editing && active) {
      const k = room + '|' + active, v = $('msg').value;
      if (v) drafts[k] = v; else delete drafts[k];
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => jset('hideout.drafts', drafts), 400);
    }
    const conv = convs.get(active);
    if (conv && look.typing && $('msg').value && Date.now() - lastTypingSent > 3000 && convKeyOf(conv)) {
      lastTypingSent = Date.now();
      wsSend({ type: 'typing', ...scopeFields(conv) });
    }
    updateMentionBox();
  });

  // ---------- @mention suggestions and emoji ----------
  function updateMentionBox() {
    const box = $('mention-box');
    const input = $('msg');
    const m = /(?:^|\s)@([A-Za-z0-9_.]*)$/.exec(input.value.slice(0, input.selectionStart == null ? input.value.length : input.selectionStart));
    const conv = convs.get(active);
    if (!m || !conv) { box.hidden = true; return; }
    const names = [...peers.values()].map((p) => p.username);
    if (conv.kind === 'ch') names.push('everyone');
    const list = names.filter((n) => lc(n).startsWith(lc(m[1]))).slice(0, 8);
    box.textContent = '';
    for (const n of list) {
      const b = el('button', '', '@' + n);
      b.type = 'button';
      b.addEventListener('click', () => {
        const pos = input.selectionStart == null ? input.value.length : input.selectionStart;
        const before = input.value.slice(0, pos).replace(/@[A-Za-z0-9_.]*$/, '@' + n + ' ');
        input.value = before + input.value.slice(pos);
        input.focus();
        box.hidden = true;
      });
      box.append(b);
    }
    box.hidden = !list.length;
  }

  const EMOJI_ALL = '😀😁😂🤣😊😍😘😎🤔😅😭😡🥳😴🤯😬🙄😇🤗🫡👍👎👏🙌🙏💪👀🔥✨💯🎉🎮🕹️🎧🍕🍔🍟🍺☕🍿❤️💔💜💙💚🧡😈💀👻🤖🐶🐱🦊🐸🐧🦄🌈⭐🌙☀️⚡❄️✅❌❓❗➕➖🚀🏆🎯🎲'.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu) || [];
  const eb = $('emoji-box');
  for (const e of EMOJI_ALL) {
    const b = el('button', '', e);
    b.type = 'button';
    b.addEventListener('click', () => {
      const i = $('msg');
      const pos = i.selectionStart == null ? i.value.length : i.selectionStart;
      i.value = i.value.slice(0, pos) + e + i.value.slice(pos);
      i.focus();
    });
    eb.append(b);
  }
  $('emoji-btn').addEventListener('click', () => { eb.hidden = !eb.hidden; });

  // ---------- search and pins ----------
  function closeSearch() { searchTerm = ''; $('searchbar').hidden = true; $('search-in').value = ''; setText('search-count', ''); }
  function runSearch() {
    searchTerm = $('search-in').value.trim().toLowerCase();
    const c = convs.get(active);
    renderLog();
    setText('search-count', searchTerm && c ? c.msgs.filter((m) => m.cls === 'chat' && !blocked[m.uid] && matchesSearch(m)).length + ' found' : '');
  }
  $('search-in').addEventListener('input', runSearch);
  $('search-x').addEventListener('click', () => { closeSearch(); renderLog(); $('log').scrollTop = $('log').scrollHeight; });
  function openPins() {
    const c = convs.get(active);
    const box = $('pn-list');
    box.textContent = '';
    const list = c ? c.msgs.filter((m) => m.pinned && !blocked[m.uid]) : [];
    if (!list.length) box.append(el('p', 'note', 'Nothing is pinned here yet. Use "⋯" then Pin on a message.'));
    for (const m of list) {
      const row = el('div', 'banrow');
      row.append(el('span', '', dispName(m.who) + ': ' + (m.body || (m.poll ? m.poll.q : m.file ? m.file.name : '')).slice(0, 140)));
      const j = el('button', '', 'Jump');
      j.type = 'button';
      j.addEventListener('click', () => { closeModal('pinsmodal'); scrollToMsg(m.id); });
      row.append(j);
      box.append(row);
    }
    openModal('pinsmodal', 'pn-close');
  }
  $('pn-close').addEventListener('click', () => closeModal('pinsmodal'));

  // ---------- polls ----------
  function openPoll() {
    $('pl-q').value = '';
    setText('pl-err', '');
    const box = $('pl-opts');
    box.textContent = '';
    for (let i = 0; i < 6; i++) { const inp = el('input'); inp.maxLength = 80; inp.placeholder = 'Option ' + (i + 1); inp.style.marginBottom = '6px'; box.append(inp); }
    openModal('pollmodal', 'pl-q');
  }
  $('poll-btn').addEventListener('click', openPoll);
  $('pl-cancel').addEventListener('click', () => closeModal('pollmodal'));
  $('pl-send').addEventListener('click', async () => {
    const conv = convs.get(active);
    const q = strip($('pl-q').value).trim();
    const opts = [...$('pl-opts').querySelectorAll('input')].map((i) => strip(i.value).trim()).filter(Boolean);
    if (!conv || !q) return setText('pl-err', 'Add a question.');
    if (opts.length < 2) return setText('pl-err', 'Add at least two options.');
    const key = convKeyOf(conv);
    if (!key) return setText('pl-err', 'Still setting up the secure channel.');
    const id = SC.randomId();
    const payload = { text: '', poll: { q, opts } };
    const data = await SC.seal(key, msgAad(conv, id), payload);
    closeModal('pollmodal');
    addMsg(conv, { cls: 'chat', id, uid: myUid, who: account.username, body: '', ts: Date.now(), mine: true, edited: 0, reacts: new Map(), votes: new Map(), reply: null, file: null, poll: payload.poll, pinned: false }, false);
    wsSend({ type: conv.kind === 'ch' ? 'chat' : 'dm', ...scopeFields(conv), id, data });
  });

  // One sealed blob per person per message holds both their emoji reactions and their poll vote.
  async function saveMine(conv, msg) {
    const key = convKeyOf(conv);
    if (!key) return;
    const e = msg.reacts.get(myUid) || [];
    const v = msg.votes.get(myUid);
    const data = e.length || v !== undefined ? await SC.seal(key, reactAad(conv, msg.id, myUid), { e, vote: v }) : null;
    wsSend({ type: 'react', ...scopeFields(conv), id: msg.id, data });
  }
  function vote(conv, msg, i) {
    if (msg.votes.get(myUid) === i) msg.votes.delete(myUid); else msg.votes.set(myUid, i);
    redraw();
    saveMine(conv, msg);
  }

  // ---------- composing ----------
  function showComposeBar() {
    const bar = $('replybar');
    if (editing) { bar.hidden = false; setText('reply-text', 'Editing your message'); }
    else if (replyTo) { bar.hidden = false; setText('reply-text', 'Replying to ' + dispName(replyTo.who) + ': ' + (replyTo.body || 'a file').slice(0, 80)); }
    else bar.hidden = true;
  }
  function cancelCompose() {
    if (editing) $('msg').value = '';
    replyTo = null;
    editing = null;
    showComposeBar();
  }
  function startReply(msg) { editing = null; replyTo = msg; showComposeBar(); $('msg').focus(); }
  function startEdit(msg) { replyTo = null; editing = msg; $('msg').value = msg.body; showComposeBar(); $('msg').focus(); }
  $('reply-x').addEventListener('click', cancelCompose);

  function setPending(file) {
    pendingFile = file;
    $('attbar').hidden = !file;
    setText('att-text', file ? '📎 ' + file.name + ' (' + fmtSize(file.size) + ')' : '');
  }
  $('attach').addEventListener('click', () => $('att-file').click());
  $('att-file').addEventListener('change', () => {
    const f = $('att-file').files && $('att-file').files[0];
    $('att-file').value = '';
    if (f) takeFile(f);
  });
  $('att-x').addEventListener('click', () => setPending(null));
  $('msg').addEventListener('paste', (e) => {
    const f = e.clipboardData && e.clipboardData.files && e.clipboardData.files[0];
    if (f && !$('msg').disabled) { e.preventDefault(); takeFile(f); }
  });
  $('log').addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  $('log').addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    e.preventDefault();
    if (!$('msg').disabled) takeFile(f);
  });
  function takeFile(f) {
    if (f.size > MAX_FILE) return pushSys(active, 'That file is too big (8 MB max).');
    setPending(f);
  }

  // Photos are re-encoded: smaller to send, and it strips location data from the picture.
  async function prepareFile(file) {
    const type = file.type || 'application/octet-stream';
    if (/^image\/(jpeg|webp)$/.test(type) || (type === 'image/png' && file.size > 4 * 1024 * 1024)) {
      try {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bmp.width * scale));
        canvas.height = Math.max(1, Math.round(bmp.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        if (bmp.close) bmp.close();
        const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
        if (blob && blob.size <= MAX_FILE) {
          return { bytes: new Uint8Array(await blob.arrayBuffer()), name: file.name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg' };
        }
      } catch { /* send the original below */ }
    }
    return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name || 'file', type };
  }

  async function uploadSealed(conv, prepared) {
    const sealed = await SC.sealBytes(convKeyOf(conv), fileAad(conv), prepared.bytes);
    let res;
    try {
      res = await fetch('/api/file', {
        method: 'PUT', body: sealed, cache: 'no-store',
        headers: { Authorization: 'Bearer ' + account.token, 'Content-Type': 'application/octet-stream' },
      });
    } catch { throw new Error('Could not reach the server.'); }
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok || !data.id) throw new Error(data.error || 'Upload failed.');
    return data.id;
  }

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const conv = convs.get(active);
    if (!conv || $('send').disabled) return;
    const text = $('msg').value.trim().slice(0, 4000);
    const key = convKeyOf(conv);
    if (!key) return pushSys(active, 'Still setting up the secure channel. Try again in a second.');

    if (editing) {
      const msg = editing;
      if (!text && !msg.file) return;
      const payload = { text };
      if (msg.reply) payload.reply = msg.reply;
      if (msg.file) payload.file = msg.file;
      if (msg.threadOf) payload.thread = msg.threadOf;
      cancelCompose();
      $('msg').value = '';
      msg.body = text;
      msg.edited = Date.now();
      redraw();
      wsSend({ type: 'edit', ...scopeFields(conv), id: msg.id, data: await SC.seal(key, msgAad(conv, msg.id), payload) });
      return;
    }

    if (!text && !pendingFile) return;
    if (pendingFile && !roomSettings.allowFiles && !isOwner) return pushSys(active, 'The room owner turned off file sharing.');
    if (conv.kind === 'ch' && roomSettings.slowMode && !isOwner) {
      const wait = Math.ceil(roomSettings.slowMode - (Date.now() - (lastSent.get(conv.id) || 0)) / 1000);
      if (wait > 0) return pushSys(active, 'Slow mode is on. You can send again in ' + wait + 's.');
    }
    if (conv.kind === 'ch') lastSent.set(conv.id, Date.now());
    const id = SC.randomId();
    const payload = { text };
    if (replyTo) payload.reply = { id: replyTo.id, who: replyTo.who, text: (replyTo.body || 'a file').slice(0, 120) };
    let fid;
    $('send').disabled = true;
    try {
      if (pendingFile) {
        setText('att-text', 'Uploading…');
        const prepared = await prepareFile(pendingFile);
        if (prepared.bytes.length > MAX_FILE) throw new Error('That file is too big (8 MB max).');
        fid = await uploadSealed(conv, prepared);
        payload.file = { id: fid, name: prepared.name, type: prepared.type, size: prepared.bytes.length };
        blobCache.set(fid, URL.createObjectURL(new Blob([prepared.bytes], { type: isImageType(prepared.type) ? prepared.type : 'application/octet-stream' })));
      }
      const data = await SC.seal(key, msgAad(conv, id), payload);
      const msg = { cls: 'chat', id, uid: myUid, who: account.username, body: text, ts: Date.now(), mine: true, edited: 0, reacts: new Map(), reply: payload.reply || null, file: null };
      if (payload.file) msg.file = { ...payload.file, name: strip(payload.file.name).slice(0, 80) };
      $('msg').value = '';
      delete drafts[room + '|' + active];
      jset('hideout.drafts', drafts);
      setPending(null);
      replyTo = null;
      showComposeBar();
      addMsg(conv, msg, false);
      wsSend({ type: conv.kind === 'ch' ? 'chat' : 'dm', ...scopeFields(conv), id, data, ...(fid ? { fid } : {}) });
    } catch (err) {
      pushSys(active, err.message || 'Could not send that.');
      if (pendingFile) setPending(pendingFile);
    } finally {
      updateComposer();
    }
  });

  async function toggleReact(conv, msg, emoji) {
    const key = convKeyOf(conv);
    if (!key) return;
    const list = [...(msg.reacts.get(myUid) || [])];
    const i = list.indexOf(emoji);
    if (i >= 0) list.splice(i, 1); else list.push(emoji);
    if (list.length) msg.reacts.set(myUid, list); else msg.reacts.delete(myUid);
    redraw();
    saveMine(conv, msg);
  }

  // Deleting waits a few seconds so it can be undone; the server is only told when the time is up.
  function deleteMsg(conv, msg) {
    conv.msgs = conv.msgs.filter((x) => x !== msg);
    conv.byId.delete(msg.id);
    const timer = setTimeout(() => commitDelete(msg.id), 6000);
    pendingDeletes.set(msg.id, { timer, conv, msg });
    redraw();
    showToast('Message deleted.', () => {
      const d = pendingDeletes.get(msg.id);
      if (!d) return;
      clearTimeout(d.timer);
      pendingDeletes.delete(msg.id);
      conv.msgs.push(msg);
      conv.msgs.sort((a, b) => a.ts - b.ts);
      conv.byId.set(msg.id, msg);
      redraw();
    });
  }
  function commitDelete(id) {
    const d = pendingDeletes.get(id);
    if (!d) return;
    clearTimeout(d.timer);
    pendingDeletes.delete(id);
    wsSend({ type: 'del', ...scopeFields(d.conv), id });
    hideToast();
  }
  const flushDeletes = () => { for (const id of [...pendingDeletes.keys()]) commitDelete(id); };
  window.addEventListener('pagehide', flushDeletes);
  let toastTimer = null;
  function showToast(text, onUndo) {
    setText('toast-text', text);
    $('toast').hidden = false;
    $('toast-undo').onclick = () => { hideToast(); onUndo(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }
  function hideToast() { $('toast').hidden = true; clearTimeout(toastTimer); }

  // ---------- threads ----------
  function openThread(conv, root) {
    threadConv = conv;
    threadRoot = root;
    $('th-input').value = '';
    renderThread();
    openModal('thread', 'th-input');
  }
  function closeThread() { threadRoot = null; threadConv = null; if (!$('thread').hidden) closeModal('thread'); }
  function renderThread() {
    if (!threadRoot || !threadConv || $('thread').hidden) return;
    const conv = threadConv;
    const row = (m, withDel) => {
      const r = el('div', 'th-row');
      r.append(makeAvatar(m.who, 32, false));
      const c = el('div', 'c');
      const head = el('div', 'head');
      head.append(el('span', 'who', dispName(m.who)), el('span', 'time', fmtTime(m.ts)));
      c.append(head);
      const body = el('div', 'body');
      renderRich(m.body || (m.poll ? '📊 ' + m.poll.q : m.file ? '📎 ' + m.file.name : ''), body);
      c.append(body);
      if (withDel && (m.mine || (isOwner && conv.kind === 'ch'))) {
        const d = el('button', 'threadbtn', 'Delete');
        d.type = 'button';
        d.addEventListener('click', () => { if (window.confirm('Delete this message for everyone?')) deleteMsg(conv, m); });
        c.append(d);
      }
      r.append(c);
      return r;
    };
    $('th-root').textContent = '';
    $('th-root').append(row(threadRoot, false));
    const list = $('th-list');
    list.textContent = '';
    const replies = conv.msgs.filter((x) => x.threadOf === threadRoot.id && !blocked[x.uid]);
    if (!replies.length) list.append(el('p', 'note', 'No replies yet.'));
    for (const m of replies) list.append(row(m, true));
    list.scrollTop = list.scrollHeight;
  }
  async function sendThreadReply() {
    const conv = threadConv, root = threadRoot;
    const text = $('th-input').value.trim().slice(0, 4000);
    if (!conv || !root || !text) return;
    const key = convKeyOf(conv);
    if (!key || !conv.byId.has(root.id)) return;
    const id = SC.randomId();
    const data = await SC.seal(key, msgAad(conv, id), { text, thread: root.id });
    $('th-input').value = '';
    addMsg(conv, { cls: 'chat', id, uid: myUid, who: account.username, body: text, ts: Date.now(), mine: true, edited: 0, reacts: new Map(), votes: new Map(), reply: null, file: null, poll: null, pinned: false, threadOf: root.id }, false);
    redraw();
    wsSend({ type: conv.kind === 'ch' ? 'chat' : 'dm', ...scopeFields(conv), id, data });
  }
  $('th-send').addEventListener('click', sendThreadReply);
  $('th-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendThreadReply(); } });
  $('th-close').addEventListener('click', closeThread);

  // ---------- saved messages ----------
  function openSaved() {
    const box = $('sv-list');
    box.textContent = '';
    const list = saved.filter((x) => x.room === room);
    if (!list.length) box.append(el('p', 'note', 'Nothing saved yet. Use the message actions, then Save.'));
    for (const x of list) {
      const row = el('div', 'banrow');
      row.append(el('span', '', dispName(x.who) + ': ' + x.text));
      const j = el('button', '', 'Jump');
      j.type = 'button';
      j.addEventListener('click', () => { closeModal('saved'); if (convs.has(x.convKey)) { openConv(x.convKey); setTimeout(() => scrollToMsg(x.id), 50); } });
      const r = el('button', '', 'Remove');
      r.type = 'button';
      r.addEventListener('click', () => { saved = saved.filter((y) => y !== x); jset('hideout.saved', saved); openSaved(); });
      row.append(j, r);
      box.append(row);
    }
    openModal('saved', 'sv-close');
  }
  $('open-saved').addEventListener('click', openSaved);
  $('sv-close').addEventListener('click', () => closeModal('saved'));
  $('open-keys').addEventListener('click', () => openModal('shortcuts', 'sc-close'));
  $('sc-close').addEventListener('click', () => closeModal('shortcuts'));

  // ---------- quick switcher and keyboard shortcuts ----------
  let swIndex = 0;
  function swItems() {
    const q = lc($('sw-in').value.trim());
    return convOrder.map((k) => convs.get(k)).filter(Boolean).filter((c) => !q || lc(c.name).includes(q)).slice(0, 12);
  }
  function renderSwitcher() {
    const items = swItems();
    swIndex = Math.min(swIndex, Math.max(0, items.length - 1));
    const box = $('sw-list');
    box.textContent = '';
    items.forEach((c, i) => {
      const b = el('button', i === swIndex ? 'sel' : '', (c.kind === 'ch' ? '# ' : '@ ') + c.name + (c.unread ? '  (' + c.unread + ')' : ''));
      b.type = 'button';
      b.addEventListener('click', () => { closeModal('switcher'); openConv(c.key); });
      box.append(b);
    });
    if (!items.length) box.append(el('p', 'note', 'No match.'));
  }
  function openSwitcher() {
    $('sw-in').value = '';
    swIndex = 0;
    renderSwitcher();
    openModal('switcher', 'sw-in');
  }
  $('sw-in').addEventListener('input', () => { swIndex = 0; renderSwitcher(); });
  $('sw-in').addEventListener('keydown', (e) => {
    const n = swItems().length || 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); swIndex = (swIndex + 1) % n; renderSwitcher(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); swIndex = (swIndex + n - 1) % n; renderSwitcher(); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = swItems()[swIndex]; if (c) { closeModal('switcher'); openConv(c.key); } }
  });
  function stepConv(dir) {
    if (!convOrder.length) return;
    const i = convOrder.indexOf(active);
    openConv(convOrder[(i + dir + convOrder.length) % convOrder.length]);
  }
  function markAllRead() {
    for (const c of convs.values()) { c.unread = 0; markRead(c); }
    renderLists();
    updateTitle();
  }
  document.addEventListener('keydown', (e) => {
    if (!joined || $('app').hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && !e.shiftKey && k.toLowerCase() === 'k') { e.preventDefault(); openSwitcher(); }
    else if (mod && k === '/') { e.preventDefault(); openModal('shortcuts', 'sc-close'); }
    else if (mod && e.shiftKey && k.toLowerCase() === 'f') { e.preventDefault(); $('searchbar').hidden = false; $('search-in').focus(); }
    else if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); stepConv(k === 'ArrowUp' ? -1 : 1); }
    else if (e.shiftKey && k === 'Escape') markAllRead();
    else if (k === 'ArrowUp' && e.target === $('msg') && !$('msg').value && !editing) {
      const c = convs.get(active);
      const mine = c ? c.msgs.filter((m) => m.cls === 'chat' && m.mine && !m.threadOf && !m.poll && m.body).pop() : null;
      if (mine) { e.preventDefault(); startEdit(mine); }
    }
  });

  // ---------- desktop app bridge ----------
  if (desk) {
    desk.onPtt((down) => { pttDown = !!down; applyTalk(); });
    desk.onGame((name) => { gameName = name || ''; if (look.autoGame && joined) broadcastStatus(); });
  }
  const syncDesk = () => {
    if (!desk) return;
    desk.setPtt(look.ptt ? look.pttKey : '');
    desk.setSettings({ gameDetect: !!look.autoGame });
  };
  async function fillDesktop() {
    $('desk-wrap').hidden = !desk;
    if (!desk) return;
    const st = (await desk.getSettings()) || {};
    $('dk-login').checked = !!st.openAtLogin;
    $('dk-tray').checked = !!st.closeToTray;
    $('dk-game').checked = !!look.autoGame;
  }
  if (desk) {
    $('dk-login').addEventListener('change', () => desk.setSettings({ openAtLogin: $('dk-login').checked }));
    $('dk-tray').addEventListener('change', () => desk.setSettings({ closeToTray: $('dk-tray').checked }));
    $('dk-game').addEventListener('change', () => { look.autoGame = $('dk-game').checked; saveLook(); syncDesk(); if (joined) broadcastStatus(); });
  }

  // ---------- channels & room settings ----------
  function openNewChannel() {
    if (!isOwner && !roomSettings.membersCanCreateChannels) return pushSys(active, 'Only the room owner can create channels here.');
    $('ch-name').value = '';
    setText('ch-err', '');
    openModal('chmodal', 'ch-name');
  }
  $('ch-add').addEventListener('click', openNewChannel);
  $('ch-cancel').addEventListener('click', () => closeModal('chmodal'));
  $('ch-save').addEventListener('click', async () => {
    const name = strip($('ch-name').value).trim().toLowerCase().replace(/\s+/g, '-').slice(0, 24);
    if (!/^[\p{L}\p{N}_-]{1,24}$/u.test(name)) return setText('ch-err', 'Use letters, numbers, dashes and underscores.');
    if ([...convs.values()].some((c) => c.kind === 'ch' && c.name === name)) return setText('ch-err', 'There is already a channel with that name.');
    wsSend({ type: 'channel-new', data: await SC.seal(roomKey, 'chname|' + room, { name }) });
    closeModal('chmodal');
  });
  $('ch-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ch-save').click(); } });

  function renderRoomSettings() {
    setText('rs-intro', isOwner
      ? 'You own this room. You can kick or ban people from their profile card, delete any message, and remove channels.'
      : 'These are the rules the room owner set. Only the owner can change them.');
    const mx = $('rs-max');
    if (!mx.options.length) for (let i = 2; i <= 12; i++) mx.add(new Option(String(i), String(i)));
    $('rs-slow').value = String(roomSettings.slowMode);
    $('rs-keep').value = String(roomSettings.retentionDays);
    mx.value = String(roomSettings.maxMembers);
    $('rs-files').checked = roomSettings.allowFiles;
    $('rs-chan').checked = roomSettings.membersCanCreateChannels;
    $('rs-lock').checked = roomSettings.lockJoin;
    for (const id of ['rs-slow', 'rs-keep', 'rs-max', 'rs-files', 'rs-chan', 'rs-lock']) $(id).disabled = !isOwner;
    const ch = $('rs-channels');
    const bn = $('rs-bans');
    ch.textContent = '';
    bn.textContent = '';
    for (const c of convs.values()) {
      if (c.kind !== 'ch') continue;
      const row = el('div', 'banrow');
      row.append(el('span', '', '# ' + c.name));
      if (c.id !== 'general') {
        const b = el('button', '', 'Delete');
        b.type = 'button';
        b.addEventListener('click', () => {
          if (window.confirm('Delete #' + c.name + ' and everything in it?')) wsSend({ type: 'channel-del', id: c.id });
        });
        row.append(b);
      }
      ch.append(row);
    }
    if (!bans.length) bn.append(el('p', 'note', 'Nobody is banned.'));
    for (const b of bans) {
      const row = el('div', 'banrow');
      row.append(el('span', '', '@' + cleanWho(b.name)));
      const u = el('button', '', 'Unban');
      u.type = 'button';
      u.addEventListener('click', () => wsSend({ type: 'unban', uid: b.uid }));
      row.append(u);
      bn.append(row);
    }
  }
  function pushSettings() {
    if (!isOwner) return;
    wsSend({ type: 'set-settings', settings: {
      slowMode: Number($('rs-slow').value), retentionDays: Number($('rs-keep').value), maxMembers: Number($('rs-max').value),
      allowFiles: $('rs-files').checked, membersCanCreateChannels: $('rs-chan').checked, lockJoin: $('rs-lock').checked,
    } });
  }
  for (const id of ['rs-slow', 'rs-keep', 'rs-max', 'rs-files', 'rs-chan', 'rs-lock']) $(id).addEventListener('change', pushSettings);
  $('room-settings').addEventListener('click', () => { renderRoomSettings(); openModal('roomset', 'rs-close'); });
  $('rs-close').addEventListener('click', () => closeModal('roomset'));
  $('viewer-close').addEventListener('click', () => closeModal('viewer'));

  // ---------- sending ----------

  // ---------- signalling (encrypted with the room key) ----------
  async function sendSignal(to, payload) {
    const data = await SC.seal(roomKey, room, { ...payload, from: myId, to });
    wsSend({ type: 'signal', to, data });
  }
  // keep per-peer signals in order
  function queueSignal(id, payload) {
    const p = peers.get(id);
    if (!p) return;
    p.out = p.out.then(() => sendSignal(id, payload)).catch(() => {});
  }

  function onSignal(m) {
    const p = peers.get(m.from);
    if (!p) return;
    p.inq = p.inq.then(() => handleSignal(m, p)).catch(() => {});
  }

  async function flushPending(c) {
    const list = c.pending; c.pending = [];
    for (const cand of list) { try { await c.pc.addIceCandidate(cand); } catch { /* ignore */ } }
  }

  async function handleSignal(m, p) {
    let s;
    try { s = await SC.open(roomKey, room, m.data); } catch { return; }
    // The payload is sealed, so the server can't forge or redirect it.
    if (!s || s.from !== m.from || s.to !== myId) return;
    const kind = s.c === 'call' ? 'call' : 'room';

    if (s.kind === 'hello') {
      const pub = s.pub;
      if (!pub || pub.kty !== 'EC' || pub.crv !== 'P-256' || typeof pub.x !== 'string' || typeof pub.y !== 'string') return;
      try {
        dmKeys.set(p.uid, await SC.dmKey(account.idKey, { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }, myUid, p.uid, room));
      } catch { return; }
      if (s.reply) queueSignal(m.from, { kind: 'hello', pub: account.idPub, reply: false });
      queueSignal(m.from, { kind: 'profile', profile: account.profile }); // introduce ourselves
      queueSignal(m.from, { kind: 'status', state: myStatusNow().state, text: myStatusNow().text });
      const conv = ensureDm(p.uid);
      wsSend({ type: 'dm-history', with: p.uid });
      const queued = p.dmQueue; p.dmQueue = [];
      for (const d of queued) await onDm(d);
      if (conv.key === active || !conv.loaded) updateComposer();
      renderLists();
    } else if (s.kind === 'profile') {
      const clean = cleanProfile(s.profile, p.username);
      if (clean) { profiles.set(lc(p.username), clean); redraw(); }
    } else if (s.kind === 'status') {
      if (['online', 'away', 'dnd'].includes(s.state)) { p.status = { state: s.state, text: typeof s.text === 'string' ? strip(s.text).slice(0, 60) : '' }; renderLists(); }
    } else if (s.kind === 'call') {
      if (blocked[p.uid]) { queueSignal(m.from, { kind: 'call', op: 'decline' }); return; }
      onCallOp(m.from, p, s.op);
    } else if (s.kind === 'offer') {
      if (!localStream || typeof s.sdp !== 'string') return;
      if (kind === 'room' && !voiceOn) return;
      if (kind === 'call' && !(call && call.id === m.from && call.state === 'on')) return;
      const ex = p.conns[kind];
      const reuse = ex && ex.pc && ex.pc.signalingState === 'stable' && ex.pc.remoteDescription; // someone started or stopped sharing their screen
      const pc = reuse ? ex.pc : makePC(m.from, kind);
      const c = p.conns[kind];
      await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp });
      await flushPending(c);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      queueSignal(m.from, { kind: 'answer', c: kind, sdp: pc.localDescription.sdp });
    } else if (s.kind === 'answer') {
      const c = p.conns[kind];
      if (!c || !c.pc || typeof s.sdp !== 'string') return;
      await c.pc.setRemoteDescription({ type: 'answer', sdp: s.sdp });
      await flushPending(c);
    } else if (s.kind === 'ice') {
      const c = p.conns[kind];
      if (!c || !c.pc || !s.candidate) return;
      if (c.pc.remoteDescription) { try { await c.pc.addIceCandidate(s.candidate); } catch { /* ignore */ } }
      else c.pending.push(s.candidate);
    }
  }

  // ---------- voice: WebRTC mesh (room-wide) and private calls ----------
  async function loadIce() {
    if (Date.now() - iceLoadedAt < 30 * 60e3) return;
    try {
      const r = await api('/api/ice', { method: 'GET', token: account.token });
      if (Array.isArray(r.iceServers) && r.iceServers.length) { rtcConfig = { iceServers: r.iceServers }; iceLoadedAt = Date.now(); }
    } catch { /* keep the default STUN server */ }
  }

  function setSpeaking(username, on) {
    const k = lc(username);
    if (on) speaking.add(k); else speaking.delete(k);
    for (const a of document.querySelectorAll('.avatar')) if (a.dataset.u === k) a.classList.toggle('speaking', on);
  }

  // Lights up a ring around someone's avatar while they talk. Audio analysis happens only on this device.
  function watchSpeaking(stream, username, isLocal) {
    const ac = getAC();
    if (!ac || !stream) return null;
    try {
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      let on = false, quiet = 0;
      const timer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) { const d = (v - 128) / 128; sum += d * d; }
        const talking = Math.sqrt(sum / buf.length) > 0.03 && !(isLocal && muted);
        if (talking) { quiet = 0; if (!on) { on = true; setSpeaking(username, true); } }
        else if (on && ++quiet > 4) { on = false; setSpeaking(username, false); }
      }, 100);
      return { stop() { clearInterval(timer); if (on) setSpeaking(username, false); try { src.disconnect(); } catch { /* gone */ } } };
    } catch { return null; }
  }

  function makePC(id, kind) {
    closeConn(id, kind);
    const p = peers.get(id);
    const c = { pc: null, audio: null, pending: [], state: 'connecting', watch: null };
    p.conns[kind] = c;
    const pc = new RTCPeerConnection(rtcConfig);
    c.pc = pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) queueSignal(id, { kind: 'ice', c: kind, candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') { addStage(id, kind, p, e.track, e.streams[0]); return; }
      if (!c.audio) {
        c.audio = document.createElement('audio');
        c.audio.autoplay = true;
        c.audio.setAttribute('playsinline', '');
        $('audio').append(c.audio);
      }
      c.audio.srcObject = e.streams[0];
      c.audio.play().catch(() => {});
      if (c.watch) c.watch.stop();
      c.watch = watchSpeaking(e.streams[0], p.username, false);
      applyAudioPrefs();
    };
    pc.onconnectionstatechange = () => {
      if (c.pc !== pc) return;
      c.state = pc.connectionState;
      renderLists();
    };
    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    if (screenStream) screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
    renderLists();
    return pc;
  }

  function closeConn(id, kind) {
    const p = peers.get(id);
    const c = p && p.conns[kind];
    if (!c) return;
    if (c.pc) { c.pc.onicecandidate = c.pc.ontrack = c.pc.onconnectionstatechange = null; c.pc.close(); }
    if (c.audio) { c.audio.srcObject = null; c.audio.remove(); }
    if (c.watch) c.watch.stop();
    removeStage(id + ':' + kind);
    delete p.conns[kind];
  }
  function closePeerConn(id) { closeConn(id, 'room'); closeConn(id, 'call'); }

  async function dial(id, kind) {
    if (!localStream || !peers.has(id)) return;
    const pc = makePC(id, kind);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    queueSignal(id, { kind: 'offer', c: kind, sdp: pc.localDescription.sdp });
  }

  async function getMicStream() {
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (look.mic) {
      try { return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: look.mic } }, video: false }); } catch { /* unplugged: use the default */ }
    }
    return navigator.mediaDevices.getUserMedia({ audio: base, video: false });
  }

  // The mic is live only if you're not muted and (when push-to-talk is on) the key is held.
  function applyTalk() {
    if (localStream) localStream.getAudioTracks().forEach((t) => { t.enabled = !muted && (!look.ptt || pttDown); });
  }
  document.addEventListener('keydown', (e) => {
    if (!look.ptt || e.repeat || !localStream || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) return;
    if (e.key.toLowerCase() === look.pttKey) { pttDown = true; applyTalk(); }
  });
  document.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === look.pttKey) { pttDown = false; applyTalk(); } });
  window.addEventListener('blur', () => { pttDown = false; applyTalk(); });

  async function switchMic() {
    if (!localStream) return;
    let next;
    try { next = await getMicStream(); } catch { return; }
    const track = next.getAudioTracks()[0];
    for (const p of peers.values()) {
      for (const c of Object.values(p.conns)) {
        const snd = c.pc && c.pc.getSenders().find((x) => x.track && x.track.kind === 'audio');
        if (snd) snd.replaceTrack(track).catch(() => {});
      }
    }
    localStream.getTracks().forEach((t) => t.stop());
    localStream = next;
    if (localWatch) localWatch.stop();
    localWatch = watchSpeaking(localStream, account.username, true);
    applyTalk();
  }

  async function acquireMic() {
    if (localStream) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      pushSys(active, 'Voice needs HTTPS (or localhost) and a browser with microphone support.');
      return false;
    }
    try {
      localStream = await getMicStream();
    } catch {
      pushSys(active, 'Could not access your microphone. Check the browser permission and try again.');
      return false;
    }
    muted = false;
    applyTalk();
    localWatch = watchSpeaking(localStream, account.username, true);
    return true;
  }

  function releaseMicIfIdle() {
    if (voiceOn || call || !localStream) return;
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    muted = false;
    if (localWatch) { localWatch.stop(); localWatch = null; }
  }

  async function startVoice() {
    if (voiceOn) return;
    if (call) hangUp();
    if (!(await acquireMic())) return;
    await loadIce();
    voiceOn = true;
    updateVoiceUI();
    renderLists();
    renderSelf();
    wsSend({ type: 'voice', on: true }); // server replies with who is already in voice
  }

  function stopVoice(notify = true) {
    if (!voiceOn) { releaseMicIfIdle(); return; }
    for (const id of peers.keys()) closeConn(id, 'room');
    voiceOn = false;
    if (!call) stopShare();
    if (notify) wsSend({ type: 'voice', on: false });
    releaseMicIfIdle();
    updateVoiceUI();
    if (joined) { renderLists(); renderSelf(); }
  }

  function updateVoiceUI() {
    const inCall = !!call && call.state === 'on';
    $('voice').textContent = voiceOn ? 'Leave voice' : 'Join voice';
    $('voice').classList.toggle('on', voiceOn);
    $('mute').hidden = !(voiceOn || inCall);
    $('share').hidden = !(voiceOn || inCall) || !(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    $('share').textContent = screenStream ? 'Stop sharing' : 'Share screen';
    $('mute').textContent = muted ? 'Unmute' : 'Mute';
  }

  $('voice').addEventListener('click', () => (voiceOn ? stopVoice() : startVoice()));
  $('mute').addEventListener('click', toggleMute);
  function toggleMute() {
    if (!localStream) return;
    muted = !muted;
    applyTalk();
    updateVoiceUI();
    renderSelf();
    renderCallBar();
  }

  // ----- screen sharing -----
  function addStage(id, kind, p, track, stream) {
    const key = id + ':' + kind;
    removeStage(key);
    const wrap = el('div', 'scr');
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.srcObject = stream;
    wrap.append(v, el('div', 'cap', dispName(p.username) + ' is sharing their screen'));
    $('stage').append(wrap);
    $('stage').hidden = false;
    stageEls.set(key, wrap);
    v.play().catch(() => {});
    track.onended = track.onmute = () => removeStage(key);
  }
  function removeStage(key) {
    const w = stageEls.get(key);
    if (!w) return;
    w.remove();
    stageEls.delete(key);
    $('stage').hidden = !stageEls.size;
  }
  async function renegotiate(id, kind) {
    const p = peers.get(id);
    const c = p && p.conns[kind];
    if (!c || !c.pc || c.pc.signalingState !== 'stable') return;
    await c.pc.setLocalDescription(await c.pc.createOffer());
    queueSignal(id, { kind: 'offer', c: kind, sdp: c.pc.localDescription.sdp });
  }
  async function startShare() {
    if (screenStream) return stopShare();
    try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); } catch { return; }
    const track = screenStream.getVideoTracks()[0];
    track.onended = stopShare;
    for (const [id, p] of peers) for (const [kind, c] of Object.entries(p.conns)) {
      if (c.pc) { screenStream.getTracks().forEach((t) => c.pc.addTrack(t, screenStream)); renegotiate(id, kind).catch(() => {}); }
    }
    updateVoiceUI();
  }
  function stopShare() {
    if (!screenStream) return;
    const ids = new Set(screenStream.getTracks());
    screenStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
    screenStream = null;
    for (const [id, p] of peers) for (const [kind, c] of Object.entries(p.conns)) {
      if (!c.pc) continue;
      for (const snd of c.pc.getSenders()) if (snd.track && ids.has(snd.track)) { try { c.pc.removeTrack(snd); } catch { /* closed */ } }
      renegotiate(id, kind).catch(() => {});
    }
    updateVoiceUI();
  }
  $('share').addEventListener('click', startShare);

  function applyAudioPrefs() {
    for (const p of peers.values()) for (const c of Object.values(p.conns)) {
      if (!c.audio) continue;
      c.audio.muted = !!blocked[p.uid];
      c.audio.volume = Math.min(1, Math.max(0, (vols[p.uid] === undefined ? 100 : vols[p.uid]) / 100));
    }
  }

  // ----- private calls from a DM -----
  function setCall(c) {
    if (call && call.timer) clearTimeout(call.timer);
    call = c;
    renderCallBar();
    renderConvActions();
    renderLists();
    renderSelf();
    updateVoiceUI();
  }

  async function placeCall(id) {
    const p = peers.get(id);
    if (!p || call) return;
    if (voiceOn) stopVoice();
    if (!(await acquireMic())) return;
    await loadIce();
    if (call || !peers.has(id)) { releaseMicIfIdle(); return; }
    setCall({ id, state: 'out', timer: setTimeout(() => { if (call && call.state === 'out') hangUp('No answer.'); }, 45000) });
    queueSignal(id, { kind: 'call', op: 'invite' });
  }

  function onCallOp(id, p, op) {
    if (op === 'invite') {
      if (call) { queueSignal(id, { kind: 'call', op: 'decline' }); return; }
      setCall({ id, state: 'in', timer: setTimeout(() => {
        if (call && call.id === id && call.state === 'in') { queueSignal(id, { kind: 'call', op: 'decline' }); endCall('Missed call from ' + dispName(p.username)); }
      }, 45000) });
      if (prefs.sound) { beep(660); setTimeout(() => beep(660), 350); }
      desktopNotify(dispName(p.username) + ' is calling', 'Open Hideout to answer', 'call');
    } else if (!call || call.id !== id) {
      // not about our current call
    } else if (op === 'accept' && call.state === 'out') {
      if (call.timer) clearTimeout(call.timer);
      call.state = 'on';
      setCall(call);
      dial(id, 'call').catch(() => {});
    } else if (op === 'decline') {
      endCall(dispName(p.username) + ' did not answer.');
    } else if (op === 'end') {
      endCall('Call ended.');
    }
  }

  async function acceptCall() {
    if (!call || call.state !== 'in') return;
    const id = call.id;
    if (voiceOn) stopVoice();
    if (!(await acquireMic())) { hangUp(); return; }
    await loadIce();
    if (!call || call.id !== id || !peers.has(id)) { releaseMicIfIdle(); return; }
    if (call.timer) clearTimeout(call.timer);
    call.state = 'on';
    setCall(call);
    queueSignal(id, { kind: 'call', op: 'accept' });
  }

  function hangUp(note) {
    if (!call) return;
    queueSignal(call.id, { kind: 'call', op: call.state === 'in' ? 'decline' : 'end' });
    endCall(typeof note === 'string' ? note : '');
  }

  function endCall(note) {
    if (!call) return;
    const p = peers.get(call.id);
    closeConn(call.id, 'call');
    setCall(null);
    if (!voiceOn) stopShare();
    releaseMicIfIdle();
    if (note && p) pushSys(dmConvKey(p.uid), note);
  }

  function renderCallBar() {
    const bar = $('callbar');
    bar.textContent = '';
    bar.hidden = !call;
    if (!call) return;
    const p = peers.get(call.id);
    const who = p ? dispName(p.username) : 'someone';
    const btn = (label, fn, cls) => { const b = el('button', cls || '', label); b.type = 'button'; b.addEventListener('click', fn); return b; };
    if (call.state === 'in') bar.append(el('span', '', '📞 ' + who + ' is calling you'), btn('Accept', acceptCall, 'primary'), btn('Decline', () => hangUp()));
    else if (call.state === 'out') bar.append(el('span', '', 'Calling ' + who + '…'), btn('Cancel', () => hangUp()));
    else bar.append(el('span', '', '📞 In a call with ' + who), btn(muted ? 'Unmute' : 'Mute', toggleMute), btn('Hang up', () => hangUp()));
  }

  // ---------- start ----------
  applyLook();
  syncDesk();
  if (!window.isSecureContext) $('insecure').hidden = false;
  $('a-user').value = recall('hideout.user');
  $('a-keep').checked = recall('hideout.keep') === '1';
  fetch('/api/config', { cache: 'no-store' })
    .then((r) => r.json())
    .then((c) => { inviteRequired = !!c.inviteRequired; setMode(mode); })
    .catch(() => {});
  setMode('login');
  // Invite links look like https://host/#room=name&code=abc
  try {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('room')) { $('room').value = h.get('room').slice(0, 64); remember('hideout.room', $('room').value); }
    if (h.get('code')) { $('a-invite').value = h.get('code').slice(0, 100); setMode('signup'); }
    if (h.get('room') || h.get('code')) history.replaceState(null, '', location.pathname);
  } catch { /* ignore a bad link */ }
  showScreen('');
  tryResume().then((ok) => {
    if (ok) { showScreen('home'); renderHome(); } else showScreen('auth');
  });
})();
