#!/usr/bin/env node
// Development only: fetch the NitrOS-9 v3.3.0 CoCo 3 release images this folder's tools, tests/nitros9.test.js,
// tests/nitros9-session.test.js, tests/os9.test.js (every image of both archives) and the browser check use, from the project's official SourceForge release (https://sourceforge.net/projects/nitros9/files/releases/
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
      'nos96309l2v030300coco3_40d_1.dsk': '6658a73c92b1a5197ce629f43d417efd04b19279de080ed754e7dfc060ce782e',
      'nos96309l2v030300coco3_40d_1_50hz.dsk': '13b94ff188faa33f20cb4a9dd7e82e041736973a3a01eca57367512f2a4de160',
      'nos96309l2v030300coco3_40d_2.dsk': '229546d50f4cb5bc1ba3794420bad3e9bda2e56493aa056c2da7e2f64570cba4',
      'nos96309l2v030300coco3_80d.dsk': '1da47995d8f0f902f5c3632c9b69262a00c945304565b7f1216e79a668bd2479',
      'nos96309l2v030300coco3_80d_50hz.dsk': 'af7c751074a3314398f3db5186c13a0fd3732cc8f0a4d0b1411e5d9d767b4386',
      'nos96309l2v030300coco3_arduino.dsk': 'df4460a8dcdeec9c24bacf18ad430d7023c281b0d03bd1b79cb1b241d82c4525',
      'nos96309l2v030300coco3_arduino_headless.dsk': 'f64f3768a778a43f80c5144d2d2de7f5fbe0dd87dac6d56774f0ee7366b9ff56',
      'nos96309l2v030300coco3_becker.dsk': 'd7c46abddc2c8c99e04f544a6806382e85e946a846c2846d3c79730b77d025ad',
      'nos96309l2v030300coco3_becker_headless.dsk': '3946e99dfab61c833dfccd7615e64150392ceed4e0f7de68f0d2bba4833c304a',
      'nos96309l2v030300coco3_cocosdc.dsk': 'ba2a488a8e9d884a2dd45f13f70d15242eaf6b50483c52711db29bef50278578',
      'nos96309l2v030300coco3_dw.dsk': 'bb7205156923b4c61f46795fa9bd2d284de79fea001e481d5574c877ab94a9c2',
      'nos96309l2v030300coco3_dw_headless.dsk': 'de0585099d2bcc8719589d937a6e6b2de3926ca31335e0876cfd34d6c7e2a5a4',
    },
  },
  'nos96809l2v030300coco3.zip': {
    sha256: 'b085d07ac4897bbb40635639061eebba466a132cd2ccb8bcfc4f1aa6f9da62c1',
    images: {
      'nos96809l2v030300coco3_40d_1.dsk': '033f9211a3af259c68fcec3132caf8e5ac62bfb4da0d441b3e45534d2b9b33b2',
      'nos96809l2v030300coco3_40d_1_50hz.dsk': '05e0261abdd02565d1e8d8e4c10abed0e63359d417284095277065a7cec70d8d',
      'nos96809l2v030300coco3_40d_2.dsk': '35c9f58d317ec6101accd1f1d5d8e7a021411b2f6edd3b488066e58ada4be595',
      'nos96809l2v030300coco3_80d.dsk': 'b4f2258ec64056ec7d2cf428ffa30c869990d3593945333c74230b904fb179a1',
      'nos96809l2v030300coco3_80d_50hz.dsk': '23d1e12bce70debd26e0ff33e85dc375209b9338a4c8013c7e64f3a54d19c9e4',
      'nos96809l2v030300coco3_arduino.dsk': '60182507c38b9a02f143928f8f611ecdd05508f2e39bbbb945636d75666c539b',
      'nos96809l2v030300coco3_arduino_headless.dsk': '268fddf83cc8025833b1469a5a78a812bab6d9fca4d437231fdf7116031c43bd',
      'nos96809l2v030300coco3_becker.dsk': '6fbea89a3544cf25d5cc6dc3ba5c70098f2b66bf234c4c20dbffac7bdb262cda',
      'nos96809l2v030300coco3_becker_headless.dsk': '3bc37513cb6774943d721bac7e8241e7fc6b80cdeb4134b0b3d37af3d3be81b4',
      'nos96809l2v030300coco3_cocosdc.dsk': '1b8dbbf5b9317c6d90ef002c1326e9cd9d7d3f6c1e2249150214addde72a994a',
      'nos96809l2v030300coco3_dw.dsk': '17ff609e030386540e465c1cdc939058da59669a871b5d0e53a5b89e0bb16027',
      'nos96809l2v030300coco3_dw_headless.dsk': '8b35ca192147763200617ba36b63e4c6c07e721b0e8218fa2e92f38a7b1aeea8',
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
