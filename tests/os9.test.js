// NitrOS-9 boot disks: js/media/os9.js (inspectOs9Disk, checkNitros9DriveWire) on hand-built images
// (tests/os9-image.js, laid out from the NitrOS-9 definitions, no NitrOS-9 bytes) and, when tools/nitros9/fetch.js
// has put them in its cache, on the official v3.3.0 CoCo 3 release images (every image in both archives; skipped
// with the reason otherwise).
const Emu = require('./load')();
const { makeOs9Disk } = require('./os9-image.js');
const { cached, cacheDir, IMAGES } = require('../tools/nitros9/fetch.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const { inspectOs9Disk, checkNitros9DriveWire, Os9ImageError } = Emu;
const throwsWith = (f, re) => { try { f(); return false; } catch (e) { return e instanceof Os9ImageError && re.test(e.message); } };

// ---- hand-built images
{
  const r = inspectOs9Disk(makeOs9Disk(Emu, { cpu: '6309', label: 'MY BOOT' }));
  check('a Becker boot disk boots', r.os9 && r.boot === 'becker' && r.reason === null, JSON.stringify(r));
  check('its volume name and CPU', r.label === 'MY BOOT' && r.cpu === '6309');
  check('the 6809 build', inspectOs9Disk(makeOs9Disk(Emu, { cpu: '6809' })).cpu === '6809');
  check('no CPU named: null', inspectOs9Disk(makeOs9Disk(Emu, { cpu: null })).cpu === null && !inspectOs9Disk(makeOs9Disk(Emu, { cpu: null })).reason);
  check('checkNitros9DriveWire passes it', checkNitros9DriveWire(makeOs9Disk(Emu)).boot === 'becker');
  check('a bigger image (DD.TOT past the file, as the release images have)', !inspectOs9Disk(makeOs9Disk(Emu, { sectors: 2467 })).reason);
}
{
  const r = inspectOs9Disk(makeOs9Disk(Emu, { port: 'bitbanger' }));
  check('bit-banger DriveWire: refused, says to use _becker.dsk', r.boot === 'drivewire' && /bit-banger/.test(r.reason) && /_becker\.dsk/.test(r.reason), r.reason);
  const f = inspectOs9Disk(makeOs9Disk(Emu, { bootTrack: false, driver: 'rb1773', sectors: 1440 }));
  check('a floppy boot disk (no boot track at LSN 612, DD on rb1773): refused as a floppy image', f.boot === 'floppy' && /floppy/.test(f.reason), f.reason);
  const o = inspectOs9Disk(makeOs9Disk(Emu, { port: 'bitbanger', driver: 'rbsuper' }));
  check('another boot device (CoCo SDC, DD on rbsuper): refused', o.boot === 'other' && /another device/.test(o.reason), o.reason);
  const d = inspectOs9Disk(makeOs9Disk(Emu, { bootTrack: false }));
  check('an OS-9 disk without a boot track (a data disk): refused', d.os9 && d.boot === null && /no boot track/.test(d.reason), d.reason);
  const h = inspectOs9Disk(makeOs9Disk(Emu, { vtio: false }));
  check('a headless build (no VTIO): refused, it has no screen', /headless/.test(h.reason) && /_becker_headless/.test(h.reason), h.reason);
}
{
  check('an empty file', /empty/.test(inspectOs9Disk(new Uint8Array(0)).reason));
  check('not whole sectors', /256-byte sectors/.test(inspectOs9Disk(new Uint8Array(1000)).reason));
  check('zeroes (a blank image): not OS-9', /isn't an OS-9 disk/.test(inspectOs9Disk(new Uint8Array(630 * 256)).reason));
  // an RS-DOS disk: its directory track, 35 x 18 x 256, LSN 0 is file data (here, text)
  const rsdos = new Uint8Array(35 * 18 * 256).fill(0xFF);
  rsdos.set([...'10 PRINT "HELLO"'].map((c) => c.charCodeAt(0)), 0);
  check('an RS-DOS disk: not OS-9', !inspectOs9Disk(rsdos).os9 && /isn't an OS-9 disk/.test(inspectOs9Disk(rsdos).reason));
  const noDir = makeOs9Disk(Emu); noDir[256] = 0x00;
  check('LSN 0 pointing at a root that is not a directory: not OS-9', !inspectOs9Disk(noDir).os9);
  const badBit = makeOs9Disk(Emu); badBit[0x07] = 3;
  check('a cluster size that is not a power of two: not OS-9', !inspectOs9Disk(badBit).os9);
  const outside = makeOs9Disk(Emu); outside[0x08] = 0x10;
  check('a root directory past the end of the image: not OS-9', !inspectOs9Disk(outside).os9);
  check('checkNitros9DriveWire throws Os9ImageError with the reason', throwsWith(() => checkNitros9DriveWire(new Uint8Array(512)), /isn't an OS-9 disk/));
  const short = makeOs9Disk(Emu).subarray(0, 620 * 256);
  check('an image too short for the boot track', /no boot track/.test(inspectOs9Disk(short).reason));
  check('an ArrayBuffer is read as bytes', !inspectOs9Disk(makeOs9Disk(Emu).buffer).reason);
}
{
  // the module walk itself, against modules laid out by hand
  const b = new Uint8Array(64);
  b.set([0x87, 0xCD, 0x00, 0x0E, 0x00, 0x09, 0xC1, 0x81, 0x00, 0x41, 0x42, 0xC3, 0, 0], 0);
  const mods = Emu.os9Modules(b, 0, 64);
  check('os9Modules: one module, its name and size', mods.length === 1 && mods[0].name === 'ABC' && mods[0].size === 14, JSON.stringify(mods));
}

// ---- the release images (every image of both archives; fetch.js pins them)
{
  const expect = (n) => /_becker\.dsk$/.test(n) ? 'becker' : /_becker_headless/.test(n) ? 'headless' : /_(dw|arduino)/.test(n) ? 'drivewire'
    : /_cocosdc/.test(n) ? 'other' : /_40d_2/.test(n) ? 'data' : 'floppy';
  let seen = 0;
  for (const n of Object.keys(IMAGES).sort()) {
    const { bytes, reason } = cached(n);
    if (!bytes) { console.log(`skip ${n}: ${reason}`); continue; }
    seen++;
    const r = inspectOs9Disk(bytes), want = expect(n), cpu = /nos96309/.test(n) ? '6309' : '6809';
    const ok = want === 'becker' ? r.boot === 'becker' && !r.reason
      : want === 'headless' ? r.boot === 'becker' && /headless/.test(r.reason)
        : want === 'data' ? r.boot === null && /no boot track/.test(r.reason) : r.boot === want && !!r.reason;
    check(`${n}: ${want}${want === 'data' ? '' : `, ${cpu}`}`, ok && r.os9 && (want === 'data' || r.cpu === cpu), JSON.stringify({ boot: r.boot, cpu: r.cpu, reason: r.reason && r.reason.slice(0, 50) }));
  }
  console.log(`(${seen} release images from ${cacheDir()})`);
}
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
