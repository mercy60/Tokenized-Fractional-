'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Jest-only shim for `@exodus/bytes/base64.js` (mapped in backend/package.json
// jest config). See ./encoding.cjs for why this exists.
//
// jsdom imports only `toBase64`; the decode helpers are Buffer-backed
// best-effort equivalents for completeness of the export surface.
// ─────────────────────────────────────────────────────────────────────────────

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  throw new TypeError('Expected a Uint8Array, ArrayBufferView or ArrayBuffer');
}

function toBase64(x, { padding = true } = {}) {
  const b64 = Buffer.from(toBytes(x)).toString('base64');
  if (padding === true) return b64;
  return b64.replace(/=+$/, '');
}

function toBase64url(x, { padding = false } = {}) {
  const b64 = Buffer.from(toBytes(x))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  if (padding === true) return b64;
  return b64.replace(/=+$/, '');
}

function fromBase64(str) {
  return new Uint8Array(Buffer.from(str, 'base64'));
}

function fromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function fromBase64any(str) {
  return fromBase64url(str.replace(/\+/g, '-').replace(/\//g, '_'));
}

module.exports = { toBase64, toBase64url, fromBase64, fromBase64url, fromBase64any };
