/*
 * Indexed-colour PNG files (ISO/IEC 15948, the PNG specification): the program pages' cards (tools/program-cards.js)
 * and a share link's preview picture.
 *
 * encodeIndexedPng writes colour type 3 (a palette) at bit depth 4 when the palette has at most 16 colours, else 8;
 * every row uses filter 2 (Up), so a picture scaled up with repeated rows packs to almost nothing. readPngHeader reads
 * the signature, IHDR and PLTE back, checking every chunk's CRC, for whoever must check a picture before taking it.
 *
 * Browser-free: CompressionStream('deflate') (zlib, RFC 1950) exists in browsers and in Node 18+.
 */
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class PngError extends Error {}

const CRC_TABLE = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc(bytes, start, end) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

async function deflate(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')));
  return new Uint8Array(await out.arrayBuffer());
}

// { width, height, pixels: Uint8Array of palette indices, row by row, palette: [[r, g, b], ...] (1 to 256) } -> bytes
export async function encodeIndexedPng({ width, height, pixels, palette }) {
  if (!(width > 0 && height > 0) || pixels.length !== width * height) throw new PngError('picture size does not match its pixels');
  if (!(palette.length >= 1 && palette.length <= 256)) throw new PngError('a palette has 1 to 256 colours');
  const depth = palette.length <= 16 ? 4 : 8;
  const stride = depth === 4 ? (width + 1) >> 1 : width;
  const rows = new Uint8Array((stride + 1) * height);
  let prev = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    line.fill(0);
    for (let x = 0; x < width; x++) {
      const v = pixels[y * width + x];
      if (v >= palette.length) throw new PngError(`pixel ${x},${y} names colour ${v}; the palette has ${palette.length}`);
      if (depth === 8) line[x] = v; else line[x >> 1] |= x & 1 ? v : v << 4;
    }
    const o = y * (stride + 1);
    rows[o] = 2;   // Up: each byte less the byte above it
    for (let i = 0; i < stride; i++) rows[o + 1 + i] = (line[i] - prev[i]) & 0xFF;
    [prev, line] = [line, prev];
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = depth; ihdr[9] = 3; // compression, filter method and interlace: 0
  const plte = new Uint8Array(palette.length * 3);
  palette.forEach(([r, g, b], i) => { plte[i * 3] = r; plte[i * 3 + 1] = g; plte[i * 3 + 2] = b; });
  const chunks = [['IHDR', ihdr], ['PLTE', plte], ['IDAT', await deflate(rows)], ['IEND', new Uint8Array(0)]];
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(size), ov = new DataView(out.buffer);
  out.set(SIGNATURE);
  let o = 8;
  for (const [type, data] of chunks) {
    ov.setUint32(o, data.length);
    for (let i = 0; i < 4; i++) out[o + 4 + i] = type.charCodeAt(i);
    out.set(data, o + 8);
    ov.setUint32(o + 8 + data.length, crc(out, o + 4, o + 8 + data.length));
    o += 12 + data.length;
  }
  return out;
}

// bytes -> { width, height, depth, colourType, compression, filter, interlace, palette: [[r, g, b], ...] or null,
// chunks: [type, ...], idat: [the IDAT chunks' data, in order] }; PngError when they are not a well-formed PNG
// (signature, chunk lengths and CRCs, IHDR first, PLTE before any IDAT, the IDATs together, IEND last)
export function readPngHeader(bytes) {
  if (!bytes || bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) throw new PngError('not a PNG file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let o = 8, head = null, palette = null;
  const idat = [];
  while (o < bytes.length) {
    if (o + 12 > bytes.length) throw new PngError('a chunk is cut short');
    const len = dv.getUint32(o), end = o + 8 + len;
    if (len > 0x7FFFFFFF || end + 4 > bytes.length) throw new PngError('a chunk is cut short');
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new PngError('a chunk has no valid type');
    if (dv.getUint32(end) !== crc(bytes, o + 4, end)) throw new PngError(`the ${type} chunk is damaged (its CRC)`);
    if (!chunks.length && type !== 'IHDR') throw new PngError('the first chunk is not IHDR');
    if (type === 'IHDR') {
      if (len !== 13 || head) throw new PngError('a bad IHDR');
      head = { width: dv.getUint32(o + 8), height: dv.getUint32(o + 12), depth: bytes[o + 16], colourType: bytes[o + 17],
        compression: bytes[o + 18], filter: bytes[o + 19], interlace: bytes[o + 20] };
    }
    if (type === 'PLTE') {
      if (len % 3 || len === 0 || palette || idat.length) throw new PngError('a bad PLTE');
      palette = [];
      for (let i = 0; i < len; i += 3) palette.push([bytes[o + 8 + i], bytes[o + 9 + i], bytes[o + 10 + i]]);
    }
    if (type === 'IDAT') {
      if (idat.length && chunks[chunks.length - 1] !== 'IDAT') throw new PngError('the IDAT chunks are not together');
      idat.push(bytes.subarray(o + 8, end));
    }
    chunks.push(type);
    o = end + 4;
    if (type === 'IEND') break;
  }
  if (chunks[chunks.length - 1] !== 'IEND' || o !== bytes.length) throw new PngError('the file does not end with IEND');
  return Object.assign(head, { palette, chunks, idat });
}
