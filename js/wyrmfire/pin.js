/*
 * WYRMFIRE: the ONE place that says which engine, converter and level disk CLOADM serves.
 *
 * WYRMFIRE is a GPL game engine for the Dragon 64 that plays Doom-format levels (https://github.com/yaniv-golan/wyrmfire).
 * CLOADM vendors its engine and converter byte for byte under examples/wyrmfire/ and serves a level disk that
 * tools/wyrmfire-vendor.js builds with that converter from Freedoom (BSD-3-Clause), downloaded at the pinned SHA-256.
 *
 * To move to another WYRMFIRE commit or tag: change this file (commit, tag, version, the hashes and sizes), then run
 *   node tools/wyrmfire-vendor.js <a wyrmfire checkout at that commit>
 * which copies the files, rebuilds the Freedoom level and refuses to write anything whose hash is not the one below.
 * tests/wyrmfire-files.test.js checks the served files against this pin, and the page shows `version` from here.
 */
export const WYRMFIRE_PIN = Object.freeze({
  version: '0.1.0',
  // wyrmfire main, "WYRMFIRE 0.1.0" (re-squashed; no release tag yet: set `tag` once v0.1.0 is cut, and keep `commit` its commit)
  commit: '31a5bb96c354b2867372099f8105e9b4f37c400f',
  tag: null,
  repo: 'https://github.com/yaniv-golan/wyrmfire',
  // the files served, relative to the site root, with their SHA-256 and size
  files: Object.freeze({
    engine: Object.freeze({ path: 'examples/wyrmfire/wyrmfire.bin', from: 'bin/wyrmfire.bin', sha256: '63fd0d1f9e9a450dd9487ba37f01c0c0e3ea0d997f3778412db52dd5f071fbcb', size: 10172 }),
    licence: Object.freeze({ path: 'examples/wyrmfire/COPYING-GPL-3.0.txt', from: 'LICENSE', sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986', size: 35149 }),
    converter: Object.freeze({ path: 'examples/wyrmfire/converter/wyrmfire-convert.js', from: 'converter/wyrmfire-convert.js', sha256: '3e203c0f35b0e26bcdaa029769cf313502f3f454fdc66f77ec95636fda6cc7d8', size: 80248 }),
    worker: Object.freeze({ path: 'examples/wyrmfire/converter/worker.js', from: 'converter/worker.js', sha256: '94413f13432c2bb0d60d13a01f97210ab393c8a33f2975d751fcede10a0ba329', size: 1433 }),
    level: Object.freeze({ path: 'examples/wyrmfire/freedoom-e1m1.vdk', sha256: 'b302593b5964dd27a4a4b7677347970fa17ff8eabcf8452d11dab0a28fd5c10e', size: 737292 }),
    // the same disk as a JVC .dsk (CLOADM's own save: a 2-byte header, 18 sectors, 2 sides; the sectors are the .vdk's,
    // byte for byte), for Help -> WYRMFIRE's downloads
    levelDsk: Object.freeze({ path: 'examples/wyrmfire/freedoom-e1m1.dsk', sha256: '3eb6989155d12876eb7cf18db77bb5ae5af20859b880ff5d8a7e024a6b821f52', size: 737282 }),
    freedoomCopying: Object.freeze({ path: 'examples/wyrmfire/freedoom/COPYING.txt', zip: 'freedoom-0.13.0/COPYING.txt', sha256: '7c62f2c520769c798774f416637eec4921e5f0aafdac1245ae7c8a8cf65fe102', size: 1644 }),
    freedoomCredits: Object.freeze({ path: 'examples/wyrmfire/freedoom/CREDITS.txt', zip: 'freedoom-0.13.0/CREDITS.txt', sha256: '72364333d295c598d75ef9553d3b3661ad0b60e27271c87b7637c74b2f46918a', size: 15872 }),
    freedoomMusic: Object.freeze({ path: 'examples/wyrmfire/freedoom/CREDITS-MUSIC.txt', zip: 'freedoom-0.13.0/CREDITS-MUSIC.txt', sha256: '2bb77677bbc4e587bba44ccb6514ee0f5397c7bb8ae9580b9188d3d6a57c0a31', size: 9388 }),
  }),
  converterVersion: '1.0.0',
  levelFormat: Object.freeze({ pack: 'HGR2', assets: 'HGA1' }),
  // How the engine runs (wyrmfire docs/RELEASE.md, manifest.run / manifest.machine): Dragon 64, 64K, PAL, the
  // DragonDOS controller WITHOUT a ROM, the level disk in drive 0 kept mounted, the engine loaded as a DragonDOS binary.
  machine: Object.freeze({ id: 'dragon64', config: Object.freeze({ ram: 64 }), controller: 'dragonfdc', drive: 0 }),
  // Freedoom 0.13.0, as wyrmfire's tools/versions.env pins it
  freedoom: Object.freeze({
    version: '0.13.0',
    url: 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip',
    zipSha256: '3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59',
    wad: 'freedoom-0.13.0/freedoom1.wad',
    wadSha256: '7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d',
    map: 'E1M1',
    site: 'https://freedoom.github.io',
  }),
});

// The Freedoom credit, in ONE place: on a screenshot or clip of the Freedoom level (js/ui/share.js), in the strip, in
// Help -> WYRMFIRE (tests/wyrmfire-files.test.js holds the page to it), and for the share card renderer to come
export const FREEDOOM_CREDIT = 'Level: Freedoom (BSD)';
// the source link for the pinned engine: the tag once there is one, else the commit
export const wyrmfireSourceUrl = (pin = WYRMFIRE_PIN) => `${pin.repo}/tree/${pin.tag || pin.commit}`;
