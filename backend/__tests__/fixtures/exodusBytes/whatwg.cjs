'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Jest-only shim for `@exodus/bytes/whatwg.js` (mapped in backend/package.json
// jest config). See ./encoding.cjs for why this exists.
//
// Reimplements the WHATWG "percent-encode after encoding" algorithm
// (https://url.spec.whatwg.org/#string-percent-encode-after-encoding) on top
// of Node's utf-8 encoder plus a windows-1252 table — the two encodings the
// URL standard can actually reach (utf-8, and windows-1252 for special-scheme
// hosts/queries). Other encodings throw like the original for unsupported
// encoder inputs.
// ─────────────────────────────────────────────────────────────────────────────

const E_ENCODING = 'Unknown encoding';

// windows-1252: bytes 0x80-0x9F differ from latin1; 0x81/0x8D/0x8F/0x90/0x9D
// are undefined (unencodable), everything else maps to its own code point.
const WIN1252_HIGH = [
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6,
  0x2030, 0x0160, 0x2039, 0x0152, null, 0x017d, null, null,
  null, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, null, 0x017e, 0x0178,
];

function charToWin1252(cp) {
  if (cp <= 0x7f) return cp;
  if (cp >= 0xa0 && cp <= 0xff) return cp;
  if (cp >= 0x80 && cp <= 0x9f) return null; // undefined in windows-1252
  for (let i = 0; i < WIN1252_HIGH.length; i++) {
    if (WIN1252_HIGH[i] === cp) return 0x80 + i;
  }
  return null; // unencodable → &#cp; fallback
}

function encodeToBytes(encoding, input) {
  if (typeof input !== 'string') throw new TypeError('Expected a string');
  if (encoding === 'utf-8') {
    // Buffer.from loose-encodes unpaired surrogates as U+FFFD, matching
    // utf8fromStringLoose.
    return new Uint8Array(Buffer.from(input, 'utf8'));
  }
  if (encoding === 'windows-1252') {
    const out = [];
    for (let i = 0; i < input.length; i++) {
      const cp = input.codePointAt(i);
      if (cp > 0xffff) i++; // surrogate pair consumed
      const b = charToWin1252(cp);
      if (b === null) {
        out.push({ fallback: cp }); // handled by caller as &#cp;
      } else {
        out.push(b);
      }
    }
    return out;
  }
  throw new RangeError(E_ENCODING);
}

// https://url.spec.whatwg.org/#string-percent-encode-after-encoding
function percentEncodeAfterEncoding(encoding, input, percentEncodeSet, spaceAsPlus = false) {
  if (typeof percentEncodeSet !== 'string' || /[^\x20-\x7E]/.test(percentEncodeSet)) {
    throw new TypeError(
      'percentEncodeSet must be a string of unique increasing codepoints in range 0x20 - 0x7e'
    );
  }
  if (typeof spaceAsPlus !== 'boolean') throw new TypeError('spaceAsPlus must be boolean');

  const inSet = new Set(Array.from(percentEncodeSet, (c) => c.charCodeAt(0)));
  const hex = (b) => `%${b.toString(16).padStart(2, '0').toUpperCase()}`;
  const emitByte = (b) => {
    if (b < 0x20 || b > 0x7e) return hex(b);
    if (inSet.has(b)) return hex(b);
    return String.fromCharCode(b);
  };
  const emitString = (str) => {
    let out = '';
    for (let i = 0; i < str.length; i++) out += emitByte(str.charCodeAt(i));
    return out;
  };

  const bytes = encodeToBytes(encoding, input);

  if (bytes instanceof Uint8Array) {
    let out = '';
    for (const b of bytes) {
      if (spaceAsPlus && b === 0x20) out += '+';
      else out += emitByte(b);
    }
    return out;
  }

  // windows-1252 path with possible unencodable code points: percent-encode
  // "&#cp;" (ASCII) for each, mirroring the original single-byte fallback.
  let out = '';
  let pending = '';
  const flush = () => {
    if (spaceAsPlus) out += pending.replace(/ /g, '+');
    else out += pending;
    pending = '';
  };
  for (const item of bytes) {
    if (typeof item === 'number') {
      if (spaceAsPlus && item === 0x20) {
        flush();
        out += '+';
      } else {
        pending += emitByte(item);
      }
    } else {
      flush();
      out += `%26%23${item.fallback}%3B`;
    }
  }
  flush();
  return out;
}

module.exports = { percentEncodeAfterEncoding };
