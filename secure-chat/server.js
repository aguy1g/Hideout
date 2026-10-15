'use strict';
/*
 * Hideout server.
 *
 * It never sees room passphrases, message text, files, voice, or profile contents.
 *   - Accounts: a username plus two ways to log in, a password and a recovery key.
 *     Each sends the server only a derived login token (re-hashed here with scrypt).
 *     The profile is stored as an encrypted blob; the key that opens it is stored
 *     "wrapped" (encrypted) once under the password and once under the recovery key.
 *   - Rooms: gated by a derived token so strangers can't join. The server stores and relays
 *     opaque encrypted blobs (messages, reactions, channel names, files) for people in the room.
 *     It does see metadata: usernames, room names, who talked to whom, and when.
 *
 * Env vars:
 *   PORT          (default 3000)
 *   DATA_DIR      where accounts, rooms and files are saved (default ./data)
 *   SIGNUP_CODE   if set, people need this invite code to create an account
 *   MAX_ACCOUNTS  cap on accounts (default 200)
 *   MAX_ROOMS     cap on rooms (default 100)
 *   ROOM_TTL_DAYS rooms nobody joined for this long are deleted (default 180)
 *   ADMIN_USERS   comma-separated usernames allowed to open the Admin page (list/remove accounts and rooms)
 *   TLS_KEY / TLS_CERT   paths to PEM files -> serve HTTPS directly
 *   TRUST_PROXY=1        use X-Forwarded-For for client IPs (behind Caddy/nginx/cloudflared)
 *   Voice relay (TURN), optional, helps people on strict networks. Pick one:
 *     CF_TURN_KEY_ID + CF_TURN_API_TOKEN       Cloudflare Realtime TURN
 *     TURN_URLS + TURN_SECRET                  your own coturn (use-auth-secret)
 *     TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');

const scrypt = promisify(crypto.scrypt);

const PORT = parseInt(process.env.PORT, 10) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';
const MAX_ACCOUNTS = parseInt(process.env.MAX_ACCOUNTS, 10) || 200;
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS, 10) || 100;
const ROOM_TTL_MS = (parseFloat(process.env.ROOM_TTL_DAYS) || 180) * 24 * 3600e3;
const ADMINS = new Set((process.env.ADMIN_USERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const MAX_PER_ROOM = 12;
const MAX_CHANNELS = 10;
const MAX_BLOB = 300000;          // encrypted profile, chars
const FILE_MAX = 8 * 1024 * 1024; // one encrypted file, bytes
const ROOM_FILES_MAX = 300 * 1024 * 1024;
const LOG_MAX = 500;              // messages kept per channel / per DM pair
const LOG_BYTES = 4e6;
const SESSION_MS = 30 * 24 * 3600e3;
const RECOVERY_SESSION_MS = 3600e3; // a recovery-key login may change the password for 1 hour
const PUBLIC = path.join(__dirname, 'public');
const USER_RE = /^[A-Za-z0-9_.]{3,20}$/;
const ID_RE = /^[A-Za-z0-9+/_=-]{8,32}$/;
const FID_RE = /^[a-f0-9]{32}$/;
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// ---------- tiny rate limiter ----------
function makeLimiter(max, windowMs) {
  const m = new Map();
  return {
    blocked(k) {
      const f = m.get(k);
      if (!f) return false;
      if (Date.now() - f.first > windowMs) { m.delete(k); return false; }
      return f.count >= max;
    },
    hit(k) {
      const f = m.get(k);
      if (!f || Date.now() - f.first > windowMs) m.set(k, { count: 1, first: Date.now() });
      else f.count++;
    },
    clear(k) { m.delete(k); },
    prune() { for (const [k, f] of m) if (Date.now() - f.first > windowMs) m.delete(k); },
  };
}
const roomFails = makeLimiter(8, 10 * 60e3);        // wrong room passphrase, per IP
const loginFailsIp = makeLimiter(20, 10 * 60e3);
const loginFailsUser = makeLimiter(10, 15 * 60e3);
const registerHits = makeLimiter(10, 60 * 60e3);
const renameHits = makeLimiter(5, 60 * 60e3);       // username changes, per account
const roomCreates = makeLimiter(10, 60 * 60e3);     // new rooms, per account
const uploadHits = makeLimiter(40, 60e3);           // file uploads, per account
const limiters = [roomFails, loginFailsIp, loginFailsUser, registerHits, renameHits, roomCreates, uploadHits];

// ---------- storage ----------
const accountsDir = path.join(DATA_DIR, 'accounts');
const roomsDir = path.join(DATA_DIR, 'rooms');
const filesDir = path.join(DATA_DIR, 'files');
for (const d of [accountsDir, roomsDir, filesDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const secretPath = path.join(DATA_DIR, 'secret.key');
let secret;
try { secret = fs.readFileSync(secretPath); } catch {
  secret = crypto.randomBytes(32);
  fs.writeFileSync(secretPath, secret, { mode: 0o600 });
}

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/*
 * usernameLower -> {
 *   uid, username, usernameLower, created, blob,
 *   pw: { salt, kdfSalt, kdfHash, wrap },   // wrap === null on older accounts (blob is keyed by the password directly)
 *   rk: null | { salt, kdfSalt, kdfHash, wrap },
 * }
 * uid never changes (even when the username does): rooms and bans refer to it.
 */
const accounts = new Map();
const byUid = new Map();
const fileFor = (lower) => path.join(accountsDir, crypto.createHash('sha256').update(lower).digest('hex') + '.json');

function normalizeAccount(a) {
  if (!a.pw) { // accounts saved by the first version
    a.pw = { salt: a.salt, kdfSalt: a.kdfSalt, kdfHash: a.kdfHash, wrap: null };
    delete a.salt; delete a.kdfSalt; delete a.kdfHash;
  }
  if (a.rk === undefined) a.rk = null;
  return a;
}

function saveAccount(a) { writeAtomic(fileFor(a.usernameLower), JSON.stringify(a)); }

for (const f of fs.readdirSync(accountsDir)) {
  if (!f.endsWith('.json')) continue;
  try {
    const a = JSON.parse(fs.readFileSync(path.join(accountsDir, f), 'utf8'));
    if (!a || typeof a.usernameLower !== 'string') continue;
    normalizeAccount(a);
    if (!a.uid) { a.uid = crypto.randomBytes(8).toString('hex'); saveAccount(a); }
    accounts.set(a.usernameLower, a);
    byUid.set(a.uid, a);
  } catch { /* skip unreadable file */ }
}
const nameOf = (uid) => (byUid.get(uid) || { username: 'unknown' }).username;

// ---------- sessions (saved as hashes, so people stay logged in across restarts) ----------
const sessionsPath = path.join(DATA_DIR, 'sessions.json');
const tokHash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const sessions = new Map(); // tokenHash -> { uid, exp, method, at }
try {
  for (const [h, s] of Object.entries(JSON.parse(fs.readFileSync(sessionsPath, 'utf8')))) {
    if (s && s.exp > Date.now() && byUid.has(s.uid)) sessions.set(h, s);
  }
} catch { /* first run */ }
function saveSessionsNow() { try { writeAtomic(sessionsPath, JSON.stringify(Object.fromEntries(sessions))); } catch { /* best effort */ } }
let sessTimer = null;
function saveSessionsSoon() {
  if (!sessTimer) sessTimer = setTimeout(() => { sessTimer = null; saveSessionsNow(); }, 800);
}
function newSession(uid, method) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(tokHash(token), { uid, exp: Date.now() + SESSION_MS, method, at: Date.now() });
  saveSessionsSoon();
  return token;
}
function sessionOf(token) {
  if (typeof token !== 'string' || token.length < 10 || token.length > 200) return null;
  const th = tokHash(token);
  const s = sessions.get(th);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(th); return null; }
  const acct = byUid.get(s.uid);
  return acct ? { acct, token, th, method: s.method, at: s.at } : null;
}

const DUMMY_SALT = crypto.randomBytes(16);
const hashAuth = (auth, salt) => scrypt(auth, salt, 32, SCRYPT_OPTS);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const fakeSalt = (lower, method) => crypto.createHmac('sha256', secret).update(`salt|${method}|${lower}`).digest().subarray(0, 16).toString('base64');

async function makeCred(salt, auth, wrap) {
  const ks = crypto.randomBytes(16);
  const h = await hashAuth(auth, ks);
  return { salt, kdfSalt: ks.toString('base64'), kdfHash: h.toString('base64'), wrap };
}

async function checkCred(cred, auth) {
  if (!cred) { await hashAuth(auth, DUMMY_SALT); return false; } // keep timing similar
  const h = await hashAuth(auth, Buffer.from(cred.kdfSalt, 'base64'));
  return crypto.timingSafeEqual(h, Buffer.from(cred.kdfHash, 'base64'));
}

// ---------- helpers ----------
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const wrapOk = (v) => isStr(v, 20, 500);

function clientIp(req) {
  if (process.env.TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sameOrigin(origin, host) {
  if (!origin) return true; // non-browser clients
  try { return new URL(origin).host === host; } catch { return false; }
}

function secHeaders(req) {
  const host = String(req.headers.host || '').replace(/[^a-zA-Z0-9.:\-\[\]]/g, '');
  return {
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src data: blob:; " +
      `connect-src 'self' ws://${host} wss://${host}; media-src blob: mediastream:; ` +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
    'Cache-Control': 'no-store',
  };
}

function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBuffer(req, limit);
  try {
    const v = JSON.parse(buf.toString('utf8') || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch { throw Object.assign(new Error('Bad request.'), { status: 400 }); }
}

function sendJson(req, res, status, obj) {
  res.writeHead(status, { ...secHeaders(req), 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
const fail = (status, error) => Object.assign(new Error(error), { status });

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function needSession(req) {
  const s = sessionOf(bearer(req));
  if (!s) throw fail(401, 'Your session expired. Log in again.');
  return s;
}

// Sensitive changes need proof it's really the owner: the current password, or a recent
// recovery-key login (for people who forgot their password).
async function reauth(s, b, ip) {
  if (s.method === 'recovery') {
    if (Date.now() - s.at > RECOVERY_SESSION_MS) throw fail(401, 'For security, log in with your recovery key again to do this.');
    return;
  }
  if (!isStr(b.currentAuth, 20, 100)) throw fail(400, 'Enter your current password.');
  const lower = s.acct.usernameLower;
  if (loginFailsIp.blocked(ip) || loginFailsUser.blocked(lower)) throw fail(429, 'Too many attempts. Try again later.');
  if (!(await checkCred(s.acct.pw, b.currentAuth))) {
    loginFailsIp.hit(ip);
    loginFailsUser.hit(lower);
    throw fail(401, 'Current password is wrong.');
  }
}

// The key that opens the profile may only change while upgrading an older account:
// then a new blob and a new password-wrap must arrive together.
function upgradeFields(acct, b) {
  if (b.blob === undefined && b.pwWrap === undefined) return null;
  if (acct.pw.wrap !== null) throw fail(400, 'Bad request.');
  if (!isStr(b.blob, 1, MAX_BLOB)) throw fail(400, 'Bad request.');
  return { blob: b.blob };
}

// ---------- voice relay (TURN) settings ----------
const STUN = [{ urls: 'stun:stun.l.google.com:19302' }];
let cfCache = null;
async function iceServers() {
  const out = [...STUN];
  const { CF_TURN_KEY_ID, CF_TURN_API_TOKEN, TURN_SECRET, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  const urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (CF_TURN_KEY_ID && CF_TURN_API_TOKEN) {
    if (!cfCache || cfCache.exp < Date.now()) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        });
        if (r.ok) {
          const j = await r.json();
          cfCache = { exp: Date.now() + 6 * 3600e3, servers: [].concat(j.iceServers || []) };
        } else console.error('Cloudflare TURN credentials request failed:', r.status);
      } catch (e) { console.error('Cloudflare TURN credentials request failed:', e.message); }
    }
    if (cfCache) out.push(...cfCache.servers);
  } else if (urls.length && TURN_SECRET) {
    const user = `${Math.floor(Date.now() / 1000) + 86400}:hideout`;
    out.push({ urls, username: user, credential: crypto.createHmac('sha1', TURN_SECRET).update(user).digest('base64') });
  } else if (urls.length && TURN_USERNAME && TURN_CREDENTIAL) {
    out.push({ urls, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
  }
  return out;
}

// ---------- rooms: persistent, with encrypted history ----------
/*
 * room = {
 *   name, auth: Buffer, owner: uid, created, lastUsed,
 *   members: [uid], bans: [{uid, name}],
 *   channels: [{ id, data }]          // data = sealed {name}; the built-in "general" has no entry
 *   logs: { channelId: [record] }, dms: { "uidA|uidB": [record] },
 *   clients: Map<id, ws>              // not saved
 * }
 * record = { id, from: uid, ts, data (sealed), fid?, edited?, reacts?: { uid: sealed } }
 */
const rooms = new Map();
const roomHash = (name) => crypto.createHash('sha256').update(name).digest('hex');
const roomFile = (name) => path.join(roomsDir, roomHash(name) + '.json');
const roomFilesDir = (name) => path.join(filesDir, roomHash(name));
const DEFAULT_SETTINGS = { slowMode: 0, allowFiles: true, membersCanCreateChannels: true, lockJoin: false, retentionDays: 0, maxMembers: MAX_PER_ROOM };
function cleanSettings(v, base) {
  const o = { ...DEFAULT_SETTINGS, ...(base || {}) };
  if (!v || typeof v !== 'object') return o;
  const int = (x, lo, hi, d) => (Number.isInteger(x) && x >= lo && x <= hi ? x : d);
  o.slowMode = int(v.slowMode, 0, 300, o.slowMode);
  o.maxMembers = int(v.maxMembers, 2, MAX_PER_ROOM, o.maxMembers);
  if ([0, 1, 7, 30, 90].includes(v.retentionDays)) o.retentionDays = v.retentionDays;
  for (const k of ['allowFiles', 'membersCanCreateChannels', 'lockJoin']) if (typeof v[k] === 'boolean') o[k] = v[k];
  return o;
}
const pairKey = (a, b) => [a, b].sort().join('|');

const dirtyRooms = new Set();
let roomTimer = null;
function writeRoom(r) {
  try {
    writeAtomic(roomFile(r.name), JSON.stringify({
      name: r.name, auth: r.auth.toString('hex'), owner: r.owner, created: r.created, lastUsed: r.lastUsed,
      members: r.members, bans: r.bans, channels: r.channels, logs: r.logs, dms: r.dms, settings: r.settings,
    }));
  } catch (e) { console.error('Could not save room:', e.message); }
}
function touch(room) {
  dirtyRooms.add(room);
  if (!roomTimer) roomTimer = setTimeout(flushRooms, 1500);
}
function flushRooms() {
  roomTimer = null;
  for (const r of dirtyRooms) writeRoom(r);
  dirtyRooms.clear();
}

function removeRoomData(name) {
  try { fs.unlinkSync(roomFile(name)); } catch { /* gone */ }
  try { fs.rmSync(roomFilesDir(name), { recursive: true, force: true }); } catch { /* gone */ }
}

for (const f of fs.readdirSync(roomsDir)) {
  if (!f.endsWith('.json')) continue;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(roomsDir, f), 'utf8'));
    if (!j || typeof j.name !== 'string') continue;
    if (Date.now() - (j.lastUsed || j.created || 0) > ROOM_TTL_MS) { removeRoomData(j.name); continue; }
    rooms.set(j.name, {
      name: j.name, auth: Buffer.from(j.auth, 'hex'), owner: j.owner, created: j.created, lastUsed: j.lastUsed || j.created,
      members: j.members || [], bans: j.bans || [], channels: j.channels || [], logs: j.logs || {}, dms: j.dms || {},
      settings: cleanSettings(j.settings), clients: new Map(),
    });
  } catch { /* skip unreadable file */ }
}

function dropFile(room, fid) {
  if (fid && FID_RE.test(fid)) fs.unlink(path.join(roomFilesDir(room.name), fid), () => {});
}

function trimLog(room, log) {
  const size = () => log.reduce((n, r) => n + r.data.length, 0);
  while (log.length > LOG_MAX || (log.length > 1 && size() > LOG_BYTES)) dropFile(room, log.shift().fid);
}

// What a client may see of a stored record.
function pub(r) {
  const o = { id: r.id, from: r.from, who: nameOf(r.from), ts: r.ts, data: r.data };
  if (r.fid) o.fid = r.fid;
  if (r.edited) o.edited = r.edited;
  if (r.pinned) o.pinned = true;
  if (r.reacts && Object.keys(r.reacts).length) o.reacts = r.reacts;
  return o;
}

// Rooms with a retention setting forget old messages.
function applyRetention() {
  for (const room of rooms.values()) {
    const days = room.settings.retentionDays;
    if (!days) continue;
    const cutoff = Date.now() - days * 86400e3;
    let changed = false;
    for (const log of [...Object.values(room.logs), ...Object.values(room.dms)]) {
      while (log.length && log[0].ts < cutoff) { dropFile(room, log.shift().fid); changed = true; }
    }
    if (changed) touch(room);
  }
}

// Files that no stored message refers to (an upload whose message never got sent) are cleaned up hourly.
function sweepFiles() {
  for (const room of rooms.values()) {
    const dir = roomFilesDir(room.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    const used = new Set();
    for (const log of [...Object.values(room.logs), ...Object.values(room.dms)]) for (const r of log) if (r.fid) used.add(r.fid);
    for (const n of names) {
      if (used.has(n)) continue;
      try { if (Date.now() - fs.statSync(path.join(dir, n)).mtimeMs > 3600e3) fs.unlinkSync(path.join(dir, n)); } catch { /* ignore */ }
    }
  }
}

const isAdmin = (acct) => ADMINS.has(acct.usernameLower);

function deleteAccount(acct) {
  for (const [h, s] of sessions) if (s.uid === acct.uid) sessions.delete(h);
  saveSessionsSoon();
  for (const w of wss.clients) if (w.uid === acct.uid) { send(w, { type: 'signed-out', reason: 'deleted' }); w.close(); }
  for (const room of rooms.values()) {
    for (const [k, log] of Object.entries(room.logs)) {
      room.logs[k] = log.filter((r) => { if (r.from !== acct.uid) { if (r.reacts) delete r.reacts[acct.uid]; return true; } dropFile(room, r.fid); return false; });
    }
    for (const [k, log] of Object.entries(room.dms)) {
      if (k.split('|').includes(acct.uid)) { for (const r of log) dropFile(room, r.fid); delete room.dms[k]; }
    }
    room.members = room.members.filter((u) => u !== acct.uid);
    room.bans = room.bans.filter((b) => b.uid !== acct.uid);
    if (room.owner === acct.uid) room.owner = room.members[0] || null;
    touch(room);
  }
  accounts.delete(acct.usernameLower);
  byUid.delete(acct.uid);
  try { fs.unlinkSync(fileFor(acct.usernameLower)); } catch { /* gone */ }
}

const roomOfSession = (s) => {
  for (const room of rooms.values()) {
    for (const c of room.clients.values()) if (c.th === s.th && c.joined) return room;
  }
  return null;
};

function dirSize(dir) {
  let n = 0;
  try { for (const f of fs.readdirSync(dir)) n += fs.statSync(path.join(dir, f)).size; } catch { /* none yet */ }
  return n;
}

// ---------- HTTP API ----------
async function api(req, res, route) {
  if (!sameOrigin(req.headers.origin, req.headers.host)) throw fail(403, 'Cross-site requests are not allowed.');
  const ip = clientIp(req);

  if (req.method === 'GET' && route === '/api/config') {
    return sendJson(req, res, 200, { inviteRequired: !!SIGNUP_CODE });
  }

  if (req.method === 'GET' && route === '/api/ice') {
    needSession(req);
    return sendJson(req, res, 200, { iceServers: await iceServers() });
  }

  // Encrypted files: the server stores and returns opaque bytes for people currently in the room.
  if (req.method === 'PUT' && route === '/api/file') {
    const s = needSession(req);
    const room = roomOfSession(s);
    if (!room) throw fail(403, 'Join a room first.');
    if (uploadHits.blocked(s.acct.uid)) throw fail(429, 'Too many uploads. Try again in a minute.');
    uploadHits.hit(s.acct.uid);
    const buf = await readBuffer(req, FILE_MAX + 200);
    if (buf.length < 29) throw fail(400, 'Bad file.');
    const dir = roomFilesDir(room.name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (dirSize(dir) + buf.length > ROOM_FILES_MAX) throw fail(413, 'This room has used up its file space. Delete some old messages with files.');
    const id = crypto.randomBytes(16).toString('hex');
    await fs.promises.writeFile(path.join(dir, id), buf, { mode: 0o600 });
    return sendJson(req, res, 200, { id });
  }
  if (req.method === 'GET' && route.startsWith('/api/file/')) {
    const s = needSession(req);
    const room = roomOfSession(s);
    const id = route.slice('/api/file/'.length);
    if (!room || !FID_RE.test(id)) throw fail(404, 'Not found.');
    let buf;
    try { buf = await fs.promises.readFile(path.join(roomFilesDir(room.name), id)); } catch { throw fail(404, 'That file is gone.'); }
    res.writeHead(200, { ...secHeaders(req), 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length });
    return res.end(buf);
  }

  if (req.method === 'GET') throw fail(404, 'Not found.');
  if (req.method !== 'POST' && req.method !== 'PUT') throw fail(405, 'Method not allowed.');
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'Send JSON.');

  if (route === '/api/salt') {
    const b = await readJson(req, 2000);
    if (!isStr(b.username, 3, 20) || !USER_RE.test(b.username)) throw fail(400, 'Bad username.');
    const method = b.method === 'recovery' ? 'recovery' : 'password';
    const lower = b.username.toLowerCase();
    const a = accounts.get(lower);
    const cred = a ? (method === 'recovery' ? a.rk : a.pw) : null;
    // Unknown names (or no recovery key) get a stable fake salt so this can't be used to list accounts.
    return sendJson(req, res, 200, { salt: cred ? cred.salt : fakeSalt(lower, method) });
  }

  if (route === '/api/register') {
    const b = await readJson(req, MAX_BLOB + 5000);
    if (!isStr(b.username, 3, 20) || !USER_RE.test(b.username)) {
      throw fail(400, 'Usernames are 3-20 letters, numbers, underscores or dots.');
    }
    const rk = b.rk;
    if (!isStr(b.salt, 20, 40) || !isStr(b.auth, 20, 100) || !wrapOk(b.wrap) || !isStr(b.blob, 1, MAX_BLOB) ||
        !rk || typeof rk !== 'object' || !isStr(rk.salt, 20, 40) || !isStr(rk.auth, 20, 100) || !wrapOk(rk.wrap)) {
      throw fail(400, 'Bad request.');
    }
    if (registerHits.blocked(ip)) throw fail(429, 'Too many sign-ups from here. Try again later.');
    registerHits.hit(ip);
    if (SIGNUP_CODE && !crypto.timingSafeEqual(sha(b.invite || ''), sha(SIGNUP_CODE))) throw fail(403, 'That invite code is not valid.');
    if (accounts.size >= MAX_ACCOUNTS) throw fail(403, 'This server is not accepting new accounts.');
    const lower = b.username.toLowerCase();
    if (accounts.has(lower)) throw fail(409, 'That username is taken.');

    const pw = await makeCred(b.salt, b.auth, b.wrap);
    const rkc = await makeCred(rk.salt, rk.auth, rk.wrap);
    if (accounts.has(lower)) throw fail(409, 'That username is taken.'); // re-check after the awaits
    const acct = {
      uid: crypto.randomBytes(8).toString('hex'), username: b.username, usernameLower: lower,
      pw, rk: rkc, blob: b.blob, created: Date.now(),
    };
    accounts.set(lower, acct);
    byUid.set(acct.uid, acct);
    saveAccount(acct);
    return sendJson(req, res, 200, { token: newSession(acct.uid, 'password'), username: acct.username, admin: isAdmin(acct) });
  }

  if (route === '/api/login') {
    const b = await readJson(req, 2000);
    if (!isStr(b.username, 3, 20) || !USER_RE.test(b.username) || !isStr(b.auth, 20, 100)) throw fail(400, 'Bad request.');
    const method = b.method === 'recovery' ? 'recovery' : 'password';
    const lower = b.username.toLowerCase();
    if (loginFailsIp.blocked(ip) || loginFailsUser.blocked(lower)) throw fail(429, 'Too many attempts. Try again later.');
    const a = accounts.get(lower);
    const cred = a ? (method === 'recovery' ? a.rk : a.pw) : null;
    const ok = await checkCred(cred, b.auth);
    if (!ok) {
      loginFailsIp.hit(ip);
      loginFailsUser.hit(lower);
      throw fail(401, method === 'recovery' ? 'Wrong username or recovery key.' : 'Wrong username or password.');
    }
    loginFailsUser.clear(lower);
    return sendJson(req, res, 200, {
      token: newSession(a.uid, method), username: a.username, blob: a.blob, wrap: cred.wrap, hasRecovery: !!a.rk, admin: isAdmin(a),
    });
  }

  // Lets the browser check a saved login is still good (and fetch the profile again).
  if (route === '/api/resume') {
    const s = needSession(req);
    return sendJson(req, res, 200, { username: s.acct.username, blob: s.acct.blob, hasRecovery: !!s.acct.rk, method: s.method, admin: isAdmin(s.acct) });
  }

  if (route === '/api/profile' && req.method === 'PUT') {
    const s = needSession(req);
    const b = await readJson(req, MAX_BLOB + 5000);
    if (!isStr(b.blob, 1, MAX_BLOB)) throw fail(400, 'Profile is too large.');
    s.acct.blob = b.blob;
    saveAccount(s.acct);
    return sendJson(req, res, 200, { ok: true });
  }

  if (route === '/api/account/username') {
    const s = needSession(req);
    const b = await readJson(req, 2000);
    if (!isStr(b.username, 3, 20) || !USER_RE.test(b.username)) {
      throw fail(400, 'Usernames are 3-20 letters, numbers, underscores or dots.');
    }
    const acct = s.acct;
    if (b.username === acct.username) throw fail(400, 'That is already your username.');
    const oldLower = acct.usernameLower;
    const newLower = b.username.toLowerCase();
    if (newLower !== oldLower && accounts.has(newLower)) throw fail(409, 'That username is taken.');
    if (renameHits.blocked(acct.uid)) throw fail(429, 'You changed your username too often. Try again later.');
    renameHits.hit(acct.uid);

    accounts.delete(oldLower);
    acct.username = b.username;
    acct.usernameLower = newLower;
    accounts.set(newLower, acct);
    saveAccount(acct);
    if (newLower !== oldLower) { try { fs.unlinkSync(fileFor(oldLower)); } catch { /* already gone */ } }
    applyRenameToRooms(acct);
    return sendJson(req, res, 200, { username: acct.username });
  }

  if (route === '/api/account/password') {
    const s = needSession(req);
    const b = await readJson(req, MAX_BLOB + 5000);
    if (!isStr(b.salt, 20, 40) || !isStr(b.auth, 20, 100) || !wrapOk(b.wrap)) throw fail(400, 'Bad request.');
    const up = upgradeFields(s.acct, { blob: b.blob });
    if (s.acct.pw.wrap === null && !up) throw fail(400, 'Bad request.'); // older accounts must upgrade in this same request
    await reauth(s, b, ip);
    s.acct.pw = await makeCred(b.salt, b.auth, b.wrap);
    if (up) s.acct.blob = up.blob;
    saveAccount(s.acct);
    revokeOthers(s.acct.uid, s.th); // other devices must log in again
    return sendJson(req, res, 200, { ok: true });
  }

  if (route === '/api/account/recovery') {
    const s = needSession(req);
    const b = await readJson(req, MAX_BLOB + 5000);
    if (!isStr(b.salt, 20, 40) || !isStr(b.auth, 20, 100) || !wrapOk(b.wrap)) throw fail(400, 'Bad request.');
    const up = upgradeFields(s.acct, b);
    if (up && !wrapOk(b.pwWrap)) throw fail(400, 'Bad request.');
    if (s.acct.pw.wrap === null && !up) throw fail(400, 'Bad request.'); // older accounts must upgrade in this same request
    await reauth(s, b, ip);
    s.acct.rk = await makeCred(b.salt, b.auth, b.wrap);
    if (up) { s.acct.blob = up.blob; s.acct.pw.wrap = b.pwWrap; }
    saveAccount(s.acct);
    return sendJson(req, res, 200, { ok: true });
  }

  if (route === '/api/account/delete') {
    const s = needSession(req);
    const b = await readJson(req, 2000);
    await reauth(s, b, ip);
    deleteAccount(s.acct);
    return sendJson(req, res, 200, { ok: true });
  }

  if (route.startsWith('/api/admin/')) {
    const s = needSession(req);
    if (!isAdmin(s.acct)) throw fail(403, 'Admins only.');
    const b = await readJson(req, 2000);
    if (route === '/api/admin/overview') {
      const online = new Set([...wss.clients].filter((w) => w.joined).map((w) => w.uid));
      return sendJson(req, res, 200, {
        accounts: [...accounts.values()].map((a) => ({ username: a.username, created: a.created, admin: isAdmin(a), online: online.has(a.uid) })),
        rooms: [...rooms.values()].map((r) => ({
          name: r.name, members: r.members.length, online: r.clients.size, channels: r.channels.length + 1,
          created: r.created, lastUsed: r.lastUsed, fileBytes: dirSize(roomFilesDir(r.name)),
        })),
      });
    }
    if (route === '/api/admin/delete-account') {
      const a = accounts.get(String(b.username || '').toLowerCase());
      if (!a || a.uid === s.acct.uid) throw fail(400, 'Pick another account.');
      deleteAccount(a);
      return sendJson(req, res, 200, { ok: true });
    }
    if (route === '/api/admin/delete-room') {
      const r = rooms.get(String(b.name || ''));
      if (!r) throw fail(404, 'No such room.');
      for (const c of r.clients.values()) { send(c, { type: 'kicked' }); c.close(); }
      rooms.delete(r.name);
      dirtyRooms.delete(r);
      removeRoomData(r.name);
      return sendJson(req, res, 200, { ok: true });
    }
    throw fail(404, 'Not found.');
  }

  if (route === '/api/account/logout-others') {
    const s = needSession(req);
    revokeOthers(s.acct.uid, s.th);
    return sendJson(req, res, 200, { ok: true });
  }

  if (route === '/api/logout') {
    sessions.delete(tokHash(bearer(req)));
    saveSessionsSoon();
    return sendJson(req, res, 200, { ok: true });
  }

  throw fail(404, 'Not found.');
}

// ---------- static files ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/crypto.js': ['crypto.js', 'text/javascript; charset=utf-8'],
};

function handler(req, res) {
  const route = (req.url || '/').split('?')[0];
  if (route.startsWith('/api/')) {
    api(req, res, route).catch((err) => {
      const status = err.status || 500;
      if (!err.status) console.error(err);
      if (!res.headersSent) sendJson(req, res, status, { error: err.status ? err.message : 'Server error.' });
    });
    return;
  }
  const entry = STATIC[route];
  if (!entry) {
    res.writeHead(404, { ...secHeaders(req), 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.readFile(path.join(PUBLIC, entry[0]), (err, buf) => {
    if (err) {
      res.writeHead(500, { ...secHeaders(req), 'Content-Type': 'text/plain' });
      return res.end('Server error');
    }
    res.writeHead(200, { ...secHeaders(req), 'Content-Type': entry[1] });
    res.end(buf);
  });
}

const useTls = process.env.TLS_KEY && process.env.TLS_CERT;
const server = useTls
  ? https.createServer({ key: fs.readFileSync(process.env.TLS_KEY), cert: fs.readFileSync(process.env.TLS_CERT) }, handler)
  : http.createServer(handler);

// ---------- WebSocket relay ----------
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 400 * 1024, // profile pictures travel as encrypted signals
  verifyClient: (info) => sameOrigin(info.origin, info.req.headers.host),
});

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function broadcast(room, obj, exceptId) {
  for (const [id, c] of room.clients) if (id !== exceptId) send(c, obj);
}

function reject(ws, message) {
  send(ws, { type: 'error', message });
  ws.close();
}

// A username change shows up live for everyone in the same rooms.
function applyRenameToRooms(acct) {
  for (const room of rooms.values()) {
    for (const c of room.clients.values()) {
      if (c.uid !== acct.uid) continue;
      c.name = acct.username;
      broadcast(room, { type: 'renamed', id: c.id, name: acct.username }, c.id);
    }
  }
}

// After a password change, every other login of this account is signed out.
function revokeOthers(uid, keepHash) {
  for (const [h, s] of sessions) if (s.uid === uid && h !== keepHash) sessions.delete(h);
  saveSessionsSoon();
  for (const ws of wss.clients) {
    if (ws.uid === uid && ws.th !== keepHash) {
      send(ws, { type: 'signed-out' });
      ws.close();
    }
  }
}

function handleJoin(ws, m) {
  if (!m || m.type !== 'join' || !isStr(m.room, 1, 64) || !isStr(m.token, 10, 200) || !isStr(m.auth, 20, 100)) {
    return reject(ws, 'Bad join request.');
  }
  const sess = sessionOf(m.token);
  if (!sess) return reject(ws, 'Your session expired. Log in again.');
  if (roomFails.blocked(ws.ip)) return reject(ws, 'Too many failed attempts. Try again later.');
  const uid = sess.acct.uid;

  const authHash = crypto.createHash('sha256').update(m.auth).digest();
  let room = rooms.get(m.room);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return reject(ws, 'This server has reached its room limit.');
    if (roomCreates.blocked(uid)) return reject(ws, 'You created too many rooms. Try again later.');
    roomCreates.hit(uid);
    room = {
      name: m.room, auth: authHash, owner: uid, created: Date.now(), lastUsed: Date.now(),
      members: [], bans: [], channels: [], logs: { general: [] }, dms: {}, settings: { ...DEFAULT_SETTINGS }, clients: new Map(),
    };
    rooms.set(m.room, room);
  } else if (!crypto.timingSafeEqual(room.auth, authHash)) {
    roomFails.hit(ws.ip);
    return reject(ws, 'Wrong room name or passphrase.');
  }
  if (room.bans.some((b) => b.uid === uid)) return reject(ws, 'You were banned from this room.');
  if (room.settings.lockJoin && !room.members.includes(uid)) return reject(ws, 'This room is closed to new members.');
  if (!room.logs.general) room.logs.general = [];
  if (!room.owner) room.owner = uid;

  // Same account joining again (reload, second tab): the newest connection wins.
  for (const [oid, oc] of room.clients) {
    if (oc.uid === uid) {
      room.clients.delete(oid);
      oc.joined = false;
      broadcast(room, { type: 'peer-left', id: oid });
      send(oc, { type: 'replaced' });
      oc.close();
    }
  }
  if (room.clients.size >= Math.min(MAX_PER_ROOM, room.settings.maxMembers)) return reject(ws, 'Room is full.');

  const id = crypto.randomBytes(6).toString('hex');
  ws.id = id;
  ws.name = sess.acct.username; // identity is vouched for by the account, not typed in
  ws.uid = uid;
  ws.th = sess.th;
  ws.voice = false;
  ws.roomName = m.room;
  ws.joined = true;

  room.lastUsed = Date.now();
  if (!room.members.includes(uid)) room.members.push(uid);
  touch(room);

  const peers = [...room.clients].map(([pid, c]) => ({ id: pid, uid: c.uid, name: c.name, voice: c.voice }));
  room.clients.set(id, ws);
  send(ws, {
    type: 'joined', id, uid, owner: room.owner, peers, channels: room.channels, settings: room.settings,
    bans: room.owner === uid ? room.bans : undefined,
  });
  broadcast(room, { type: 'peer-joined', id, uid, name: ws.name }, id);
}

// Works out which stored log a message belongs to, or null if the request is invalid.
function scopeOf(room, ws, kind, m) {
  if (kind === 'ch') {
    if (typeof m.ch !== 'string') return null;
    if (m.ch !== 'general' && !room.channels.some((c) => c.id === m.ch)) return null;
    return { kind, ch: m.ch, log: (room.logs[m.ch] = room.logs[m.ch] || []) };
  }
  const to = kind === 'dm-history' ? m.with : m.to;
  if (typeof to !== 'string' || to === ws.uid || !room.members.includes(to)) return null;
  const k = pairKey(ws.uid, to);
  return { kind: 'dm', to, log: (room.dms[k] = room.dms[k] || []) };
}

// Sends an event to everyone who should see it, except the person who caused it.
// `ev` describes the conversation from the receiver's point of view: { ch } or { dm: otherPersonsUid }.
function deliver(room, sc, ws, make) {
  if (sc.kind === 'ch') {
    for (const c of room.clients.values()) if (c !== ws) send(c, make({ ch: sc.ch }));
  } else {
    for (const c of room.clients.values()) if (c.uid === sc.to) send(c, make({ dm: ws.uid }));
  }
}

function handle(ws, m) {
  const room = rooms.get(ws.roomName);
  if (!room || !m || typeof m.type !== 'string') return;

  switch (m.type) {
    case 'chat':
    case 'dm': {
      const sc = scopeOf(room, ws, m.type === 'chat' ? 'ch' : 'dm', m);
      if (!sc || !isStr(m.id, 8, 32) || !ID_RE.test(m.id) || !isStr(m.data, 1, 60000)) return;
      if (m.fid !== undefined && !room.settings.allowFiles && room.owner !== ws.uid) return;
      if (sc.kind === 'ch' && room.settings.slowMode && room.owner !== ws.uid) {
        const last = (ws.lastChat = ws.lastChat || {})[sc.ch] || 0;
        if (Date.now() - last < room.settings.slowMode * 1000) { send(ws, { type: 'slow', ch: sc.ch, wait: Math.ceil((room.settings.slowMode * 1000 - (Date.now() - last)) / 1000) }); return; }
        ws.lastChat[sc.ch] = Date.now();
      }
      if (m.fid !== undefined && !(typeof m.fid === 'string' && FID_RE.test(m.fid) &&
          fs.existsSync(path.join(roomFilesDir(room.name), m.fid)))) return;
      if (sc.log.some((r) => r.id === m.id)) return;
      const rec = { id: m.id, from: ws.uid, ts: Date.now(), data: m.data };
      if (m.fid) rec.fid = m.fid;
      sc.log.push(rec);
      trimLog(room, sc.log);
      touch(room);
      const out = pub(rec);
      deliver(room, sc, ws, (ev) => (sc.kind === 'ch' ? { type: 'chat', ch: ev.ch, rec: out } : { type: 'dm', rec: out }));
      break;
    }

    case 'edit':
    case 'del':
    case 'react': {
      const sc = scopeOf(room, ws, typeof m.ch === 'string' ? 'ch' : 'dm', m);
      if (!sc || !isStr(m.id, 8, 32)) return;
      const idx = sc.log.findIndex((r) => r.id === m.id);
      if (idx < 0) return;
      const rec = sc.log[idx];
      if (m.type === 'edit') {
        if (rec.from !== ws.uid || !isStr(m.data, 1, 60000)) return;
        rec.data = m.data;
        rec.edited = Date.now();
        deliver(room, sc, ws, (ev) => ({ type: 'edit', ...ev, id: rec.id, data: rec.data, edited: rec.edited }));
      } else if (m.type === 'del') {
        if (rec.from !== ws.uid && !(sc.kind === 'ch' && room.owner === ws.uid)) return;
        sc.log.splice(idx, 1);
        dropFile(room, rec.fid);
        deliver(room, sc, ws, (ev) => ({ type: 'del', ...ev, id: rec.id }));
      } else {
        if (m.data === null) { if (rec.reacts) delete rec.reacts[ws.uid]; }
        else if (isStr(m.data, 1, 2000)) { rec.reacts = rec.reacts || {}; rec.reacts[ws.uid] = m.data; }
        else return;
        deliver(room, sc, ws, (ev) => ({ type: 'react', ...ev, id: rec.id, uid: ws.uid, data: m.data }));
      }
      touch(room);
      break;
    }

    case 'pin': {
      const sc = scopeOf(room, ws, typeof m.ch === 'string' ? 'ch' : 'dm', m);
      if (!sc || !isStr(m.id, 8, 32)) return;
      const rec = sc.log.find((r) => r.id === m.id);
      if (!rec) return;
      rec.pinned = m.on === true;
      if (!rec.pinned) delete rec.pinned;
      touch(room);
      deliver(room, sc, ws, (ev) => ({ type: 'pin', ...ev, id: rec.id, on: !!rec.pinned }));
      break;
    }

    case 'typing': {
      const sc = scopeOf(room, ws, typeof m.ch === 'string' ? 'ch' : 'dm', m);
      if (!sc || Date.now() - (ws.lastTyping || 0) < 1500) return;
      ws.lastTyping = Date.now();
      deliver(room, sc, ws, (ev) => ({ type: 'typing', ...ev, uid: ws.uid }));
      break;
    }

    case 'history':
    case 'dm-history': {
      const sc = scopeOf(room, ws, m.type === 'history' ? 'ch' : 'dm-history', m);
      if (!sc) return;
      const items = sc.log.slice(-LOG_MAX).map(pub);
      send(ws, m.type === 'history' ? { type: 'history', ch: sc.ch, items } : { type: 'dm-history', with: sc.to, items });
      break;
    }

    case 'channel-new': {
      if (!isStr(m.data, 10, 2000) || room.channels.length >= MAX_CHANNELS) return;
      if (!room.settings.membersCanCreateChannels && room.owner !== ws.uid) return;
      const ch = { id: crypto.randomBytes(5).toString('hex'), data: m.data };
      room.channels.push(ch);
      room.logs[ch.id] = [];
      touch(room);
      broadcast(room, { type: 'channel', id: ch.id, data: ch.data });
      break;
    }

    case 'channel-del': {
      if (room.owner !== ws.uid || typeof m.id !== 'string') return;
      const i = room.channels.findIndex((c) => c.id === m.id);
      if (i < 0) return;
      room.channels.splice(i, 1);
      for (const r of room.logs[m.id] || []) dropFile(room, r.fid);
      delete room.logs[m.id];
      touch(room);
      broadcast(room, { type: 'channel-gone', id: m.id });
      break;
    }

    case 'set-settings': {
      if (room.owner !== ws.uid) return;
      room.settings = cleanSettings(m.settings, room.settings);
      touch(room);
      broadcast(room, { type: 'room-settings', settings: room.settings });
      applyRetention();
      break;
    }

    case 'dm-clear': {
      const sc = scopeOf(room, ws, 'dm-history', m);
      if (!sc) return;
      for (const r of sc.log) dropFile(room, r.fid);
      sc.log.length = 0;
      touch(room);
      deliver(room, sc, ws, (ev) => ({ type: 'dm-cleared', ...ev }));
      break;
    }

    case 'kick':
    case 'ban': {
      if (room.owner !== ws.uid) return;
      const target = room.clients.get(m.id);
      if (!target || target === ws) return;
      if (m.type === 'ban' && !room.bans.some((b) => b.uid === target.uid)) {
        room.bans.push({ uid: target.uid, name: target.name });
        touch(room);
        send(ws, { type: 'bans', bans: room.bans });
      }
      send(target, { type: 'kicked', banned: m.type === 'ban' });
      target.close();
      break;
    }

    case 'unban': {
      if (room.owner !== ws.uid) return;
      room.bans = room.bans.filter((b) => b.uid !== m.uid);
      touch(room);
      send(ws, { type: 'bans', bans: room.bans });
      break;
    }

    case 'signal': {
      if (!isStr(m.to, 1, 32) || !isStr(m.data, 1, 300000)) return;
      const target = room.clients.get(m.to);
      if (target) send(target, { type: 'signal', from: ws.id, data: m.data });
      break;
    }

    case 'voice': {
      const on = m.on === true;
      ws.voice = on;
      broadcast(room, { type: 'voice-state', id: ws.id, on }, ws.id);
      if (on) {
        const ids = [...room.clients].filter(([id, c]) => id !== ws.id && c.voice).map(([id]) => id);
        send(ws, { type: 'voice-peers', ids });
      }
      break;
    }
  }
}

function leave(ws) {
  if (!ws.joined) return;
  const room = rooms.get(ws.roomName);
  if (!room) return;
  if (room.clients.get(ws.id) === ws) room.clients.delete(ws.id);
  broadcast(room, { type: 'peer-left', id: ws.id });
}

wss.on('connection', (ws, req) => {
  ws.ip = clientIp(req);
  ws.joined = false;
  ws.alive = true;
  ws.msgCount = 0;
  ws.bytes = 0;

  const joinTimer = setTimeout(() => { if (!ws.joined) ws.terminate(); }, 10000);
  const rate = setInterval(() => { ws.msgCount = 0; ws.bytes = 0; }, 1000);

  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    ws.bytes += raw.length;
    if (++ws.msgCount > 80 || ws.bytes > 5 * 1024 * 1024) return ws.close(1008, 'Rate limit');
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!ws.joined) handleJoin(ws, m);
    else handle(ws, m);
  });
  ws.on('close', () => { clearTimeout(joinTimer); clearInterval(rate); leave(ws); });
  ws.on('error', () => {});
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
  for (const l of limiters) l.prune();
  const now = Date.now();
  let changed = false;
  for (const [t, s] of sessions) if (s.exp < now) { sessions.delete(t); changed = true; }
  if (changed) saveSessionsSoon();
}, 30000).unref();
setInterval(() => { applyRetention(); sweepFiles(); }, 3600e3).unref();
applyRetention();

function shutdown() {
  flushRooms();
  saveSessionsNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`Hideout listening on ${useTls ? 'https' : 'http'}://localhost:${PORT}`);
  console.log(`Data is saved in ${DATA_DIR}${SIGNUP_CODE ? ' (invite code required to sign up)' : ''}`);
  if (!useTls) console.log('Note: microphone access needs HTTPS (or localhost). See README / put it behind a TLS proxy.');
});

module.exports = { server, wss };
