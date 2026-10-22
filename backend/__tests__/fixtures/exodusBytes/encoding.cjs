'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Jest-only shim for `@exodus/bytes/encoding-lite.js` and
// `@exodus/bytes/encoding.js` (mapped in backend/package.json jest config).
//
// Background: jsdom's dependency chain (html-encoding-sniffer, whatwg-url,
// jsdom itself) `require()`s these ESM-only subpaths. Jest's runtime refuses
// to require() any file whose package is `"type": "module"` — the guard fires
// *before* transformation, so no transform can help; the module must resolve
// to a CJS file. Node itself loads the real package outside Jest (native
// require(esm) / import), so production and dev behavior is untouched.
//
// The implementations below mirror the APIs the jsdom chain imports and are
// built on Node's own WHATWG primitives (global TextDecoder/TextEncoder,
// Buffer), which are spec-compliant for the encodings Node ships with.
// ─────────────────────────────────────────────────────────────────────────────

const { TextDecoder, TextEncoder, TextDecoderStream, TextEncoderStream } = globalThis;

const E_ENCODING = 'Unknown encoding';
const replacementChar = '\uFFFD';

// https://encoding.spec.whatwg.org/#names-and-labels (common labels)
const LABELS = {
  'utf-8': ['unicode-1-1-utf-8', 'utf8'],
  'utf-16le': ['utf-16', 'ucs-2', 'ucs2', 'unicode', 'unicodefeff'],
  'utf-16be': ['unicodefffe'],
  'ibm866': ['csibm866'],
  'replacement': [],
  'windows-1252': ['cp1252', 'cp819', 'ibm819', 'x-cp1252'],
  'iso-8859-1': ['8859-1', 'ascii', 'cp1252', 'csisolatin1', 'ibm819', 'iso-ir-100', 'iso8859-1', 'iso88591', 'iso_8859-1', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252'],
  'iso-8859-2': ['8859-2', 'csisolatin2', 'iso-ir-101', 'iso8859-2', 'iso88592', 'iso_8859-2', 'l2', 'latin2'],
  'iso-8859-3': ['8859-3', 'csisolatin3', 'iso-ir-109', 'iso8859-3', 'iso88593', 'iso_8859-3', 'l3', 'latin3'],
  'iso-8859-4': ['8859-4', 'csisolatin4', 'iso-ir-110', 'iso8859-4', 'iso88594', 'iso_8859-4', 'l4', 'latin4'],
  'iso-8859-5': ['8859-5', 'csisolatincyrillic', 'cyrillic', 'iso-ir-144', 'iso8859-5', 'iso88595', 'iso_8859-5'],
  'iso-8859-6': ['8859-6', 'arabic', 'csisolatinarabic', 'ecma-114', 'iso-ir-127', 'iso8859-6', 'iso88596', 'iso_8859-6'],
  'iso-8859-7': ['8859-7', 'csisogreek', 'ecma-118', 'elot_928', 'greek', 'greek8', 'iso-ir-126', 'iso8859-7', 'iso88597', 'iso_8859-7'],
  'iso-8859-8': ['8859-8', 'csisolatinhebrew', 'hebrew', 'iso-ir-138', 'iso8859-8', 'iso88598', 'iso_8859-8', 'visual'],
  'iso-8859-8-i': ['csisolatinhebrew', 'iso-ir-138', 'iso8859-8', 'iso88598', 'iso_8859-8'],
  'iso-8859-10': ['8859-10', 'csisolatin6', 'iso-ir-157', 'iso8859-10', 'iso885910', 'l6', 'latin6'],
  'iso-8859-13': ['8859-13', 'iso8859-13', 'iso885913'],
  'iso-8859-14': ['8859-14', 'iso8859-14', 'iso885914'],
  'iso-8859-15': ['8859-15', 'iso8859-15', 'iso885915'],
  'iso-8859-16': ['8859-16', 'iso8859-16', 'iso885916'],
  'koi8-r': ['cskoi8r', 'koi', 'koi8', 'koi8_r'],
  'koi8-u': ['koi8-ru'],
  'macintosh': ['csmacintosh', 'mac', 'x-mac-roman'],
  'windows-874': ['dos-874', 'iso-8859-11', 'iso8859-11', 'iso885911', 'tis-620'],
  'windows-1250': ['cp1250', 'csisolatin2', 'x-cp1250'],
  'windows-1251': ['cp1251', 'x-cp1251'],
  'windows-1253': ['cp1253', 'x-cp1253'],
  'windows-1254': ['cp1254', 'csisolatin5', 'iso-8859-9', 'iso8859-9', 'iso88599', 'x-cp1254'],
  'windows-1255': ['cp1255', 'x-cp1255'],
  'windows-1256': ['cp1256', 'x-cp1256'],
  'windows-1257': ['cp1257', 'x-cp1257'],
  'windows-1258': ['cp1258', 'x-cp1258'],
  'x-mac-cyrillic': ['x-mac-cyrillic'],
  'gbk': ['chinese', 'csgb2312', 'csiso58gb231280', 'gb2312', 'gb_2312', 'gb_2312-80', 'iso-ir-58'],
  'gb18030': [],
  'big5': ['big5-hkscs', 'cn-big5', 'csbig5', 'x-x-big5'],
  'euc-jp': ['csiso2022jp', 'iso-2022-jp'],
  'euc-kr': ['cseuckr', 'csksc56011987', 'iso-ir-149', 'korean', 'ks_c_5601-1987', 'ks_c_5601-1989', 'ksc5601', 'ksc_5601', 'windows-949'],
  'shift_jis': ['ms_kanji', 'shift-jis', 'sjis', 'windows-31j', 'x-sjis'],
};

const namesByAlias = new Map();
for (const [name, aliases] of Object.entries(LABELS)) {
  namesByAlias.set(name, name);
  for (const alias of aliases) if (!namesByAlias.has(alias)) namesByAlias.set(alias, name);
}

/** https://encoding.spec.whatwg.org/#get-an-encoding (lowercased names). */
function normalizeEncoding(label) {
  if (typeof label !== 'string') return null;
  if (label === 'utf-8' || label === 'utf8' || label === 'UTF-8' || label === 'UTF8') return 'utf-8';
  if (/[^\w\t\n\f\r .:-]/i.test(label)) return null; // must be ASCII
  const low = label.trim().toLowerCase();
  return namesByAlias.get(low) || null;
}

const uppercasePrefixes = new Set(['utf', 'iso', 'koi', 'euc', 'ibm', 'gbk']);

/** Case-sensitive canonical name, per the spec. */
function labelToName(label) {
  const enc = normalizeEncoding(label);
  if (enc === 'utf-8') return 'UTF-8';
  if (!enc) return enc;
  if (uppercasePrefixes.has(enc.slice(0, 3))) return enc.toUpperCase();
  if (enc === 'big5') return 'Big5';
  if (enc === 'shift_jis') return 'Shift_JIS';
  return enc;
}

/** Detect a Unicode BOM; returns the canonical encoding name or undefined. */
function getBOMEncoding(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return 'UTF-8';
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff) return 'UTF-16BE';
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe) return 'UTF-16LE';
  return undefined;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input.byteLength === 'number') return new Uint8Array(input);
  throw new TypeError('Argument must be an ArrayBuffer or ArrayBufferView');
}

/**
 * BOM-first decode used by jsdom for bytes sources. Mirrors
 * `legacyHookDecode(input, fallbackEncoding)` from the real package.
 */
function legacyHookDecode(input, fallbackEncoding = 'utf-8') {
  let u8 = toBytes(input);
  const bomEncoding = getBOMEncoding(u8);
  if (bomEncoding) u8 = u8.subarray(bomEncoding === 'utf-8' ? 3 : 2);
  const enc = bomEncoding || normalizeEncoding(fallbackEncoding);
  if (!enc) throw new RangeError(E_ENCODING);
  if (enc === 'replacement') return u8.byteLength > 0 ? replacementChar : '';
  // Node's WHATWG TextDecoder covers utf-8, utf-16le/be and the WHATWG
  // legacy encodings (non-fatal, replaces invalid sequences with U+FFFD),
  // matching the "loose" decode semantics of the original.
  const nodeLabel =
    enc === 'utf-16be' ? 'utf-16be' :
    enc === 'utf-16le' ? 'utf-16le' :
    enc;
  try {
    return new TextDecoder(nodeLabel, { ignoreBOM: true, fatal: false }).decode(u8);
  } catch {
    throw new RangeError(E_ENCODING);
  }
}

/** Byte → latin1 string (one char per byte). */
function isomorphicDecode(input) {
  const u8 = toBytes(input);
  let out = '';
  for (let i = 0; i < u8.length; i++) out += String.fromCharCode(u8[i]);
  return out;
}

/** latin1 string → bytes (low byte of each code unit). */
function isomorphicEncode(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

module.exports = {
  TextDecoder,
  TextEncoder,
  TextDecoderStream,
  TextEncoderStream,
  normalizeEncoding,
  getBOMEncoding,
  labelToName,
  legacyHookDecode,
  isomorphicDecode,
  isomorphicEncode,
};
