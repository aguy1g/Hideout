/*
 * Crypto helpers shared by the browser client and the Node test.
 * Everything is derived from the room name + passphrase, which never leave the device.
 *   auth token : PBKDF2 (salt "auth") -> sent to server only to gate room access
 *   room key   : PBKDF2 (salt "enc")  -> AES-256-GCM, used for chat AND voice signalling
 */
(function (root) {
  'use strict';
  const webcrypto = root.crypto || require('node:crypto').webcrypto;
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const ITER = 250000;

  function toB64(buf) {
    const b = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromB64(s) {
    const bin = atob(s);
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    return b;
  }

  function randomId() {
    return toB64(webcrypto.getRandomValues(new Uint8Array(12)));
  }

  async function derive(room, passphrase) {
    const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
    const salt = (label) => enc.encode(`hideout-v1|${label}|${room}`);
    const authBits = await subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt: salt('auth') }, base, 256);
    const key = await subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt: salt('enc') },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { auth: toB64(authBits), key };
  }

  async function seal(key, room, obj) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(room) }, key, enc.encode(JSON.stringify(obj)));
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return toB64(out);
  }

  async function open(key, room, b64) {
    const buf = fromB64(b64);
    if (buf.length < 29) throw new Error('too short');
    const pt = await subtle.decrypt(
      { name: 'AES-GCM', iv: buf.subarray(0, 12), additionalData: enc.encode(room) }, key, buf.subarray(12));
    return JSON.parse(dec.decode(pt));
  }

  // ---- Direct messages: per-pair key from an ephemeral ECDH exchange ----
  // Each person makes a throwaway key pair on join. Public halves are exchanged inside
  // room-key-sealed "hello" messages (so the server can't swap them). The shared secret
  // is known only to the two people involved, so other room members can't read DMs.
  async function genPair() {
    return subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  }

  async function exportPub(pair) {
    const j = await subtle.exportKey('jwk', pair.publicKey);
    return { kty: j.kty, crv: j.crv, x: j.x, y: j.y };
  }

  async function dmKey(pair, pubJwk, idA, idB, room) {
    const pub = await subtle.importKey('jwk', pubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, pair.privateKey, 256);
    const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const [a, b] = [idA, idB].sort();
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(`hideout-dm-v1|${room}|${a}|${b}`), info: enc.encode('aes-gcm') },
      hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // ---- Accounts: one PBKDF2 run gives a login token AND a profile-encryption key ----
  // The server only ever receives the login token, so it can store your profile
  // but can't read it.
  function randomSalt() {
    return toB64(webcrypto.getRandomValues(new Uint8Array(16)));
  }

  async function deriveAccount(password, saltB64) {
    const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const salt = new Uint8Array([...fromB64(saltB64), ...enc.encode('|hideout-account-v1')]);
    const bits = new Uint8Array(
      await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', iterations: ITER, salt }, base, 512));
    const key = await subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { auth: toB64(bits.slice(0, 32)), key };
  }

  // ---- Master key + recovery key ----
  // A random master key encrypts the profile. It is stored "wrapped" (encrypted) once under
  // the password and once under the recovery key, so either one can open it, and changing
  // the password only means re-wrapping a tiny value.
  // The master key is extractable on purpose: "stay logged in" saves it (as a key object) in this browser,
  // and changing the password needs its raw bytes to re-wrap it.
  const importAes = (raw) => subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);

  async function newMasterKey() {
    const raw = webcrypto.getRandomValues(new Uint8Array(32));
    return { raw, key: await importAes(raw) };
  }

  function wrapMaster(credKey, raw) {
    return seal(credKey, 'hideout-wrap-v1', { k: toB64(raw) });
  }

  async function unwrapMaster(credKey, wrap) {
    const o = await open(credKey, 'hideout-wrap-v1', wrap);
    const raw = fromB64(o.k);
    if (raw.length !== 32) throw new Error('bad master key');
    return { raw, key: await importAes(raw) };
  }

  // 160 random bits as 8 groups of 4 characters (Crockford base32: no I, L, O or U).
  const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  function generateRecoveryKey() {
    const bytes = webcrypto.getRandomValues(new Uint8Array(20));
    let bits = 0, acc = 0, out = '';
    for (const b of bytes) {
      acc = (acc << 8) | b;
      bits += 8;
      while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
      acc &= (1 << bits) - 1;
    }
    return out.match(/.{4}/g).join('-');
  }

  // Accepts any case, with or without dashes/spaces; returns null if it can't be a valid key.
  function normalizeRecoveryKey(s) {
    const t = String(s).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/.test(t) ? t : null;
  }

  // ---- Files: raw bytes sealed with AES-GCM (iv || ciphertext) ----
  async function sealBytes(key, aad, bytes) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes);
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return out;
  }

  async function openBytes(key, aad, bytes) {
    const buf = new Uint8Array(bytes);
    if (buf.length < 29) throw new Error('too short');
    return new Uint8Array(await subtle.decrypt(
      { name: 'AES-GCM', iv: buf.subarray(0, 12), additionalData: enc.encode(aad) }, key, buf.subarray(12)));
  }

  // ---- Long-term identity key (for DMs that keep their history) ----
  // Saved inside the encrypted profile, so only the account owner can read it.
  async function genIdentity() {
    const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const j = await subtle.exportKey('jwk', pair.privateKey);
    return { kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d };
  }

  function validIdentity(j) {
    return !!j && typeof j === 'object' && j.kty === 'EC' && j.crv === 'P-256' &&
      ['x', 'y', 'd'].every((k) => typeof j[k] === 'string' && j[k].length > 20 && j[k].length < 100);
  }

  async function importIdentity(j) {
    const priv = await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, d: j.d },
      { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    return { privateKey: priv, pub: { kty: 'EC', crv: 'P-256', x: j.x, y: j.y } };
  }

  const api = {
    toB64, fromB64, randomId, derive, seal, open, genPair, exportPub, dmKey, randomSalt, deriveAccount,
    newMasterKey, wrapMaster, unwrapMaster, generateRecoveryKey, normalizeRecoveryKey,
    sealBytes, openBytes, genIdentity, validIdentity, importIdentity,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SC = api;
})(typeof self !== 'undefined' ? self : globalThis);
