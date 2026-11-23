// Small byte helpers for the preview's images: no `file`, `stat` or `base64` programs, so
// nothing waits on a process.

// FNV-1a over bytes, plus the length: a content name for a cache file.
export function hashBytes(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36) + bytes.length.toString(36);
}

const B64 = new Int16Array(128).fill(-1);
"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".split("").forEach((c, i) => { B64[c.charCodeAt(0)] = i; });

// Base64 text (whitespace ignored) to bytes.
export function fromBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let n = 0, bits = 0, acc = 0;
  for (let i = 0; i < clean.length; i++) {
    acc = (acc << 6) | B64[clean.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) { bits -= 8; out[n++] = (acc >> bits) & 0xff; }
  }
  return out.subarray(0, n);
}

const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u32be = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

// { width, height } from an image's header (PNG, GIF, JPEG, WebP), or from an SVG's own
// width/height (else its viewBox). Null when it can't tell.
export function imageSize(bytes, ext) {
  const b = bytes;
  if (ext === "svg" || (b[0] === 0x3c /* < */)) {
    // The attributes are ASCII: no TextDecoder needed (the runtime may lack one).
    const head = /<svg\b[^>]*>/i.exec(String.fromCharCode(...b.subarray(0, 4096)))?.[0] ?? "";
    const num = (n) => { const v = new RegExp(`\\s${n}\\s*=\\s*["']([\\d.]+)(px)?["']`, "i").exec(head); return v ? Number(v[1]) : null; };
    const box = /\sviewBox\s*=\s*["'][\d.\s,-]*?([\d.]+)[\s,]+([\d.]+)["']/i.exec(head);
    const width = num("width") ?? (box ? Number(box[1]) : null), height = num("height") ?? (box ? Number(box[2]) : null);
    return width && height ? { width, height } : null;
  }
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { width: u32be(b, 16), height: u32be(b, 20) }; // PNG IHDR
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { width: u16le(b, 6), height: u16le(b, 8) }; // GIF
  if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57) { // RIFF....WEBP
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
    if (kind === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (kind === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) { // JPEG: walk the segments to a start-of-frame
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
      i += 2 + u16be(b, i + 2);
    }
  }
  return null;
}
