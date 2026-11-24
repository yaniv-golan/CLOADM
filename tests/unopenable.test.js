// A file CLOADM doesn't open (Session.unopenable): a photo or a PDF dropped on the screen is said to be none of the
// kinds CLOADM opens, with the list (OPENS_TEXT) in the toast's Details, instead of the raw-load address prompt. A .bin
// or a file with no extension may be a memory dump and still gets the prompt; a file with an extension the list names
// is never called unopenable (a damaged tape is a damaged tape). The list must be the real one: every extension the
// page's Open… picker accepts for programs is in it (but .img, NitrOS-9's DriveWire picker's), and nothing else. The
// page's toast is the browser check's "unopenable" group.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };

(async () => {
  const { OPENS_TEXT } = await import('../js/session.js');
  const s = new Emu.Session({ store: Emu.memoryStore() });
  s.switchMachine('dragon64', undefined, { menu: false });
  const junk = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 1, 2, 3, 0xFF, 9]);

  // ---- 1. the sentence and its Details ----
  const no = s.unopenable('photo.jpg', junk);
  check('a photo: "<name> isn\'t a file CLOADM opens."', no && no.text === 'photo.jpg isn\'t a file CLOADM opens.', JSON.stringify(no));
  check('a photo: the Details list what it opens', no && no.details === 'It opens tapes (.cas, .wav, .c10, .k7), disks (.vdk, .dsk, .jvc, .dmk, .os9), programs (.bin, .bas, .txt), cartridges (.rom, .ccc, .dgn), snapshots (.cloadm), ROM images and ZIPs of these.', JSON.stringify(no));
  check('a PDF too, whatever the letter case', !!s.unopenable('Notes.PDF', junk));

  // ---- 2. what still goes to the raw-load prompt, or loads as itself ----
  check('a .bin of unknown format: may be a memory dump (the prompt)', s.unopenable('dump.bin', junk) === null);
  check('no extension: may be a memory dump (the prompt)', s.unopenable('dump', junk) === null);
  for (const n of ['game.raw', 'core.ram', 'crash.dmp', 'snap.mem']) check(`${n}: a memory dump's name (the prompt)`, s.unopenable(n, junk) === null);
  check('a .hex (not a raw dump) is said, with its way in on the page', !!s.unopenable('prog.hex', junk));
  check('.img (NitrOS-9\'s DriveWire images, opened on that panel, not by Open…) is said', !!s.unopenable('os9.img', junk));
  // the extension in any letter case
  check('PROG.BIN of unknown bytes: the prompt', s.unopenable('PROG.BIN', junk) === null);
  check('DUMP (no extension, upper case): the prompt', s.unopenable('DUMP', junk) === null);
  check('PHOTO.JPG: said, its name as given', JSON.stringify(s.unopenable('PHOTO.JPG', junk)) === JSON.stringify({ text: 'PHOTO.JPG isn\'t a file CLOADM opens.', details: OPENS_TEXT }));
  check('BAD.CAS (a known extension in upper case): not said', s.unopenable('BAD.CAS', junk) === null);
  check('a damaged .cas: not called unopenable', s.unopenable('bad.cas', junk) === null);
  // a real program with an unknown extension opens as what it is (identified by its bytes, not its name)
  const decb = Uint8Array.from([0x00, 0x00, 0x02, 0x30, 0x00, 0x12, 0x39, 0xFF, 0x00, 0x00, 0x30, 0x00]);
  check('a DECB binary named .dat: opens (identified by its content)', s.unopenable('game.dat', decb) === null);
  const listing = new TextEncoder().encode('10 PRINT "HELLO"\n20 GOTO 10\n');
  check('a BASIC listing named .lst: opens', s.unopenable('hello.lst', listing) === null);

  // ---- 3. the list is the real one: the page's program picker accepts exactly these ----
  const html = fs.readFileSync(path.join(__dirname, '..', 'play', 'index.html'), 'utf8');
  const accept = (id) => new RegExp(`id="${id}"[^>]*accept="([^"]+)"`).exec(html)[1].split(',').filter((x) => x.startsWith('.')).map((x) => x.slice(1));
  const listed = [...OPENS_TEXT.matchAll(/\.([a-z0-9]+)/g)].map((x) => x[1]);
  const picker = accept('fileProgram');
  const missing = picker.filter((x) => !listed.includes(x)), extra = listed.filter((x) => !picker.includes(x));
  check('every extension Open… accepts is listed, and nothing it doesn\'t', !missing.length && !extra.length, `missing ${missing} extra ${extra}`);
  check('the Library\'s picker adds only ZIPs (which the list names)', accept('fileLib').filter((x) => !picker.includes(x)).join() === 'zip' && /ZIPs/.test(OPENS_TEXT));

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
