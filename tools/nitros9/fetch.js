#!/usr/bin/env node
// Development only: fetch the NitrOS-9 v3.3.0 CoCo 3 release images this folder's tools and tests/nitros9.test.js
// use, from the project's official SourceForge release (https://sourceforge.net/projects/nitros9/files/releases/
// v3.3.0/), check every archive and image against the SHA-256 pinned here, and unpack the images into a cache
// folder outside the repository. No NitrOS-9 file is committed to this repository. Prints the folder.
//   node tools/nitros9/fetch.js [--dir DIR]      (default: cacheDir() below)
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const BASE = 'https://downloads.sourceforge.net/project/nitros9/releases/v3.3.0/';
// archive -> { sha256, images: { name: sha256 } }
const PINNED = {
  'nos96309l2v030300coco3.zip': {
    sha256: 'cd37be6b203ec48aea8882392fbe1f23c6d8461f8028904ab0c9b80d1eb2cee8',
    images: {
      'nos96309l2v030300coco3_becker.dsk': 'd7c46abddc2c8c99e04f544a6806382e85e946a846c2846d3c79730b77d025ad',
    },
  },
  'nos96809l2v030300coco3.zip': {
    sha256: 'b085d07ac4897bbb40635639061eebba466a132cd2ccb8bcfc4f1aa6f9da62c1',
    images: {
      'nos96809l2v030300coco3_becker.dsk': '6fbea89a3544cf25d5cc6dc3ba5c70098f2b66bf234c4c20dbffac7bdb262cda',
    },
  },
};
const IMAGES = Object.assign({}, ...Object.values(PINNED).map((p) => p.images));
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const cacheDir = () => process.env.NITROS9_CACHE || path.join(os.tmpdir(), 'cloadm-nitros9');

// an image from the cache: its bytes if present and matching its pin, otherwise null with the reason
function cached(name, dir = cacheDir()) {
  if (!(name in IMAGES)) throw new Error(`${name} is not a pinned image`);
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return { bytes: null, reason: `${file} not found (node tools/nitros9/fetch.js fetches it)` };
  const bytes = new Uint8Array(fs.readFileSync(file));
  if (sha256(bytes) !== IMAGES[name]) return { bytes: null, reason: `${file} does not match its pinned SHA-256` };
  return { bytes, reason: null };
}

async function fetchAll(dir = cacheDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const { readZip } = await import('../../js/media/zip.js');
  for (const [zip, pin] of Object.entries(PINNED)) {
    if (Object.keys(pin.images).every((n) => cached(n, dir).bytes)) continue;
    const res = await fetch(BASE + zip, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${zip}: HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (sha256(bytes) !== pin.sha256) throw new Error(`${zip}: SHA-256 ${sha256(bytes)}, pinned ${pin.sha256}`);
    for (const e of readZip(bytes)) {
      if (!(e.name in pin.images)) continue;
      if (sha256(e.data) !== pin.images[e.name]) throw new Error(`${e.name}: SHA-256 does not match the pin`);
      fs.writeFileSync(path.join(dir, e.name), e.data);
    }
    const missing = Object.keys(pin.images).filter((n) => !cached(n, dir).bytes);
    if (missing.length) throw new Error(`${zip}: no ${missing.join(', ')} in the archive`);
  }
  return dir;
}

module.exports = { PINNED, IMAGES, sha256, cacheDir, cached, fetchAll };

if (require.main === module) {
  const argv = process.argv.slice(2), i = argv.indexOf('--dir');
  fetchAll(i >= 0 ? argv[i + 1] : cacheDir()).then((dir) => console.log(dir), (e) => { console.error(e.message); process.exitCode = 1; });
}
