// Reading the movies MAME writes with -aviwrite: one bitmap per emulated frame, in order, with
// no dependence on when MAME happens to refresh its screen (unlike its live bitmap). The format
// is plain RIFF/AVI: an 'hdrl' list with one 'strl' per stream, then a 'movi' list of frames.
const fs = require('fs');

const FOURCC = (d, o) => d.toString('ascii', o, o + 4);
const u32 = (d, o) => d.readUInt32LE(o);

// Walk the chunks of one RIFF chunk body, calling fn(id, size, dataOffset) for each.
function chunks(d, start, end, fn) {
  let off = start;
  while (off + 8 <= end) {
    const id = FOURCC(d, off), size = u32(d, off + 4);
    const body = off + 8;
    fn(id, size, body);
    off = body + size + (size & 1);
  }
}

// { w, h, bitCount, videos: [frame Buffer], audioBytes }
function readAvi(file) {
  const d = fs.readFileSync(file);
  if (FOURCC(d, 0) !== 'RIFF' || FOURCC(d, 8) !== 'AVI ') throw new Error(`${file}: not an AVI file`);
  let w = 0, h = 0, bitCount = 0, comp = null;
  const videoChunks = [];
  chunks(d, 12, d.length, (id, size, body) => {
    if (id !== 'LIST') return;
    const type = FOURCC(d, body);
    if (type === 'hdrl') {
      let stream = -1;
      chunks(d, body + 4, body + size, (sid, ssize, sbody) => {
        if (sid === 'LIST' && FOURCC(d, sbody) === 'strl') {
          stream++;
          let isVideo = false;
          chunks(d, sbody + 4, sbody + ssize, (tid, tsize, tbody) => {
            if (tid === 'strh') isVideo = FOURCC(d, tbody) === 'vids';
            if (tid === 'strf' && isVideo && !w) {
              w = d.readInt32LE(tbody + 4);
              h = Math.abs(d.readInt32LE(tbody + 8));
              bitCount = d.readUInt16LE(tbody + 14);
              comp = FOURCC(d, tbody + 16);
            }
          });
        }
      });
    } else if (type === 'movi') {
      chunks(d, body + 4, body + size, (vid, vsize, vbody) => {
        if (/^\d\ddc$/.test(vid) || /^\d\ddb$/.test(vid)) videoChunks.push(d.subarray(vbody, vbody + vsize));
      });
    }
  });
  return { w, h, bitCount, comp, frames: videoChunks };
}

// One AVI frame -> RGBA words (0xAABBGGRR, as the Frame tables use), rows top-down.
function toRGBA(avi, buf) {
  const { w, h, bitCount } = avi, bpp = bitCount >> 3;
  const stride = Math.floor((w * bitCount + 31) / 32) * 4;
  const out = new Uint32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = (h - 1 - y) * stride;              // AVI stores rows bottom-up
    for (let x = 0; x < w; x++) {
      const i = row + x * bpp;
      out[y * w + x] = (0xFF000000 | (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]) >>> 0;
    }
  }
  return out;
}

module.exports = { readAvi, toRGBA };
