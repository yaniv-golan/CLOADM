// NitrOS-9 boot test (development and verification only; not a statement of NitrOS-9 support). The official
// NitrOS-9 v3.3.0 Level 2 CoCo 3 DriveWire images (6809 and 6309) boot on our CoCo 3 with our own loader
// (js/machines/nitros9.js, the one the page uses) in place of the CoCo 3 ROM, served by our DriveWire server over the Becker port; the
// test types `dir` at the shell and checks:
//  - the screen text (video memory laid out as the GIME's text mode shows it: tools/nitros9/lib.js screenText), against the
//    NitrOS-9 v3.3.0 sources that print it (tag v3.3.0 of github.com/nitros9project/nitros9):
//      level1/modules/init.asm:96, 126   "NitrOS-9/" <cpu> " Level 2 V3.3.0", "Tandy Color Computer 3"
//      level1/modules/sysgo.asm:51        "(C) 2014 The NitrOS-9 Project"
//      level2/coco3/startup.dw and level2/coco3_6309/startup.dw (the disks' `startup`): the three echo lines
//      level1/cmds/shellplus.asm:198, 200 "Shell+ v2.2a", the default prompt "{@|#}$:" -> "{Term|02}/DD:"
//      level1/cmds/dir.asm:70             " Directory of "
//      level2/coco3/makefile, target $(DSKBECKER): the root holds OS9Boot (os9gen), CMDS, SYS, DEFS, sysgo,
//                                         startup and NITROS9
//  - every DriveWire transaction but TIME (tools/nitros9/lib.js record()), in order, against the run of the same
//    image and loader in MAME 0.264 with the same server (tools/nitros9/boot-mame.js --record, kept in
//    tests/fixtures/nitros9/: sector numbers and status codes only, no NitrOS-9 data).
// The floppy images (the release's _40d_1.dsk, 6809 and 6309) boot the same way with our floppy loader (js/machines/
// nitros9.js) in place of the CoCo 3 ROM and the CoCo disk controller (no ROM of its own) holding the image in drive 0.
// Return is typed at the startup's time prompt, then `dir` (tools/nitros9/lib.js FLOPPY), and the test checks:
//  - the screen text, against the sources: init.asm and sysgo.asm as above; level2/coco3/startup (the two echo lines,
//    then `setime </1`); level1/cmds/setime.asm:75, 77 "yyyy/mm/dd hh:mm:ss", "Time ? "; Shell+ and dir as above;
//    level2/coco3/makefile, target $(DSK360K_1): the root holds OS9Boot, CMDS, SYS, DEFS, sysgo and startup
//  - every CPU write to the controller's registers ($FF40-$FF4F), in order, against the run of the same image and
//    loader in MAME 0.264 (tools/nitros9/boot-floppy-mame.js --record, in tests/fixtures/nitros9/: register numbers
//    and values only, no NitrOS-9 data).
// The images are not in this repository: node tools/nitros9/fetch.js puts them in a cache ($NITROS9_CACHE or the
// system's temporary folder), pinned by SHA-256. Without them every case is skipped with the reason, so
// tests/all.js never needs the network.
//
// Both cases boot fully. The 6309 image clears the kernel's system page with TFM r0,r1+ ($113B, the source parked
// and the destination counting up); before the HD6309 TFM fix that form walked the source instead, the kernel
// stopped with "FAILED", and this case was recorded as an expected failure. It is a full boot check now, and it
// fails if the boot does not reach the shell.
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { cached, cacheDir, IMAGES } = require('../tools/nitros9/fetch.js');
const lib = require('../tools/nitros9/lib.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };

const PROMPT = '{Term|02}/DD:';
const ROOT_ENTRIES = ['OS9Boot', 'CMDS', 'SYS', 'DEFS', 'sysgo', 'startup', 'NITROS9'];
const FPS = 60;

// boot to the prompt (at most `bootSeconds`), type dir, run until the prompt is back after the listing, then two
// seconds more (the drive idle)
async function boot(cpu, bytes, bootSeconds) {
  const { dw, transactions } = await lib.driveWire(Emu, bytes);
  const m = lib.coco3(Emu, cpu, dw);
  const screen = () => lib.screenText(m);
  const run = async (frames, until) => {
    for (let f = 0; f < frames; f++) {
      while (!m.runFrame()) await m.stall;
      if (until && until()) return true;
    }
    return false;
  };
  const prompted = await run(bootSeconds * FPS, () => screen().includes(PROMPT));
  const booted = screen();
  if (!prompted) return { prompted, booted, listed: false, lines: booted, transactions };
  m.typist.type('dir\r');
  const listed = await run(20 * FPS, () => {
    const l = screen(), d = l.findIndex((s) => s.startsWith(' Directory of '));
    return d >= 0 && l.slice(d + 1).includes(PROMPT);
  });
  await run(2 * FPS);
  return { prompted, booted, listed, lines: screen(), transactions };
}

function fixture(cpu) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nitros9', `coco3-${cpu}-becker.json`), 'utf8'));
}

// the full check of a boot that is expected to work
function checkBoot(cpu, image, r, ref) {
  const L = r.booted;
  const has = (s) => L.includes(s);
  check(`${cpu}: the boot reaches the shell prompt ${PROMPT}`, r.prompted, r.prompted ? '' : JSON.stringify(L.slice(-4)));
  check(`${cpu}: init's banner (init.asm:96, 126)`, has(`NitrOS-9/${cpu} Level 2 V3.3.0`) && has('Tandy Color Computer 3'));
  check(`${cpu}: sysgo's banner (sysgo.asm:51)`, has('(C) 2014 The NitrOS-9 Project'));
  check(`${cpu}: startup's echo lines (startup.dw)`, has('* Welcome to NitrOS-9 Level 2 *') && has('*      with DriveWire 4       *') && has('*   on the Color Computer 3   *'));
  check(`${cpu}: Shell+ signs on (shellplus.asm:198)`, L.some((s) => s.startsWith('Shell+ v2.2a ')));
  const d = r.lines.findIndex((s) => s.startsWith(' Directory of '));
  const listing = d >= 0 ? r.lines.slice(d + 1, r.lines.indexOf(PROMPT, d)).join(' ').split(/\s+/).filter(Boolean) : [];
  check(`${cpu}: dir lists the root (dir.asm:70; makefile $(DSKBECKER))`, r.listed && ROOT_ENTRIES.every((n) => listing.includes(n)) && listing.length === ROOT_ENTRIES.length, JSON.stringify(listing));
  check(`${cpu}: dir is typed at the prompt`, r.lines.includes(`${PROMPT}dir`));
  check(`${cpu}: the MAME reference is for this image`, ref.sha256 === IMAGES[image] && ref.mame.startsWith('0.264'), ref.mame);
  const n = Math.min(r.transactions.length, ref.transactions.length);
  let first = -1;
  for (let i = 0; i < n && first < 0; i++) if (r.transactions[i] !== ref.transactions[i]) first = i;
  if (first < 0 && r.transactions.length !== ref.transactions.length) first = n;
  check(`${cpu}: every DriveWire transaction (but TIME) as in MAME 0.264, in order`, first < 0,
    first < 0 ? `(${r.transactions.length})` : `(first difference at ${first}: ours ${r.transactions[first]}, MAME ${ref.transactions[first]})`);
}

// the floppy boot: the FLOPPY schedule (Return at the time prompt, then dir), recording the controller's writes
async function bootFloppy(cpu, bytes) {
  const m = lib.coco3Floppy(Emu, cpu, bytes), writes = lib.fdcWrites(m);
  for (let f = 1; f <= lib.FLOPPY.seconds * 60 - 2; f++) {
    while (!m.runFrame()) await m.stall;
    for (const t of lib.FLOPPY.typed) if (f === t.at * 60) m.typist.type(t.text);
  }
  return { lines: lib.screenText(m), writes };
}
const FLOPPY_ROOT = ['OS9Boot', 'CMDS', 'SYS', 'DEFS', 'sysgo', 'startup'];
function checkFloppy(cpu, image, r, ref) {
  const L = r.lines, has = (x) => L.includes(x);
  check(`${cpu} floppy: init's and sysgo's banners`, has(`NitrOS-9/${cpu} Level 2 V3.3.0`) && has('Tandy Color Computer 3') && has('(C) 2014 The NitrOS-9 Project'), JSON.stringify(L.slice(0, 4)));
  check(`${cpu} floppy: startup's echo lines (level2/coco3/startup)`, has('* Welcome to NitrOS-9 Level 2 *') && has('*   on the Color Computer 3   *'));
  check(`${cpu} floppy: setime's prompt, answered (setime.asm:75, 77)`, has('       yyyy/mm/dd hh:mm:ss') && L.some((x) => x.startsWith('Time ?')));
  check(`${cpu} floppy: Shell+ signs on and dir is typed at its prompt`, L.some((x) => x.startsWith('Shell+ v2.2a ')) && has(`${PROMPT}dir`));
  const d = L.findIndex((x) => x.startsWith(' Directory of '));
  const listing = d >= 0 ? L.slice(d + 1, L.indexOf(PROMPT, d)).join(' ').split(/\s+/).filter(Boolean) : [];
  check(`${cpu} floppy: dir lists the root (makefile $(DSK360K_1)), and the prompt is back`, d >= 0 && L[L.length - 1] === PROMPT &&
    FLOPPY_ROOT.every((n) => listing.includes(n)) && listing.length === FLOPPY_ROOT.length, JSON.stringify(listing));
  check(`${cpu} floppy: the MAME reference is for this image and schedule`, ref.sha256 === IMAGES[image] && ref.mame.startsWith('0.264') && ref.seconds === lib.FLOPPY.seconds &&
    JSON.stringify(ref.typed) === JSON.stringify(lib.FLOPPY.typed), ref.mame);
  const n = Math.min(r.writes.length, ref.writes.length);
  let first = -1;
  for (let i = 0; i < n && first < 0; i++) if (r.writes[i] !== ref.writes[i]) first = i;
  if (first < 0 && r.writes.length !== ref.writes.length) first = n;
  check(`${cpu} floppy: every write to the controller's registers as in MAME 0.264, in order`, first < 0,
    first < 0 ? `(${r.writes.length})` : `(first difference at ${first}: ours ${r.writes[first]}, MAME ${ref.writes[first]})`);
}

(async () => {
  for (const cpu of ['6809', '6309']) {
    const image = `nos9${cpu}l2v030300coco3_40d_1.dsk`, { bytes, reason } = cached(image);
    if (!bytes) { console.log(`skip ${cpu} floppy: ${reason}`); continue; }
    checkFloppy(cpu, image, await bootFloppy(cpu, bytes), JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'nitros9', `coco3-${cpu}-floppy.json`), 'utf8')));
  }
  const cases = [{ cpu: '6809', image: 'nos96809l2v030300coco3_becker.dsk' }, { cpu: '6309', image: 'nos96309l2v030300coco3_becker.dsk' }];
  for (const { cpu, image } of cases) {
    const { bytes, reason } = cached(image);
    if (!bytes) { console.log(`skip ${cpu}: ${reason}`); continue; }
    const ref = fixture(cpu);
    checkBoot(cpu, image, await boot(cpu, bytes, 40), ref);
  }
  console.log(`(images from ${cacheDir()})`);
  console.log(fail ? `${fail} FAILED` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('FAIL', e.stack); process.exitCode = 1; });
