// The tape's extras: Session.ejectTape, tapeStatus's file count on a tape of several files, the name a recording is
// saved under (Session.recordingName) and the library's unique-name helper (MediaLibrary.uniqueName).
// Recordings are real: the project's own writer firmware (tools/mame-diff/tape/csave.asm, which writes a namefile
// block, a data block and an end block as BASIC's CSAVEM does) runs as the Dragon 32's ROM while the deck records,
// with the name in its namefile block changed per case; no ROM is used. Expected names are written out here.
// Run: node tests/tape-extras.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
const { MemoryMediaStore } = require('../js/host/media-store-memory.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const SRC = fs.readFileSync(path.join(__dirname, '..', 'tools', 'mame-diff', 'tape', 'csave.asm'), 'utf8');
const frames = (s, k) => { for (let i = 0; i < k; i++) s.advance(1000 / s.shownMachine.fps + 0.01); };

// the writer firmware with an 8-character name in its namefile block, as a 16K image for the Dragon 32's socket
function writer(name8) {
  if (name8.length !== 8) throw new Error('8 characters');
  const src = SRC.replace(/NAMEF\s+FCC\s+"CLOADM  "/, `NAMEF   FCC     "${name8}"`);
  if (src === SRC && name8 !== 'CLOADM  ') throw new Error('the name line was not found');
  const res = Emu.assemble(src, '6809');
  const img = new Uint8Array(0x4000).fill(0x12);
  for (const sg of res.segments) img.set(sg.data, sg.addr - 0x8000);
  return { img, halt: res.symbols.get('HALT') };
}
// record what the firmware writes, `times` runs of it (a reset between) into one recording -> stopTapeRecording()
function record(s, name8, times = 1) {
  const w = writer(name8), m = s.shownMachine;
  m.setRoms({ basic: w.img });
  s.startTapeRecording();
  for (let n = 0; n < times; n++) {
    m.reset(true);
    let t = 0;
    for (let i = 0; i < 400 && m.cpu.pc !== w.halt; i++) s.advance(20, { now: () => t });
  }
  return s.stopTapeRecording();
}
const at = new Date(2026, 10, 23, 9, 5);

(async () => {
  const s = new Emu.Session({ media: new MemoryMediaStore() });
  s.switchMachine('dragon32');

  // ---- recording names, five cases ----
  const hello = record(s, 'HELLO   ');
  check('CSAVE "HELLO": saved as HELLO.CAS, one file', JSON.stringify(Emu.Session.recordingName(hello.cas, at)) === JSON.stringify({ name: 'HELLO.CAS', files: 1 }),
    JSON.stringify(Emu.Session.recordingName(hello.cas, at)));
  const blank = record(s, '        ');
  check('a blank name: "Recording HH-MM.cas" (the time it was saved)', Emu.Session.recordingName(blank.cas, at).name === 'Recording 09-05.cas', Emu.Session.recordingName(blank.cas, at).name);
  check('no header at all (nothing decoded): "Recording HH-MM.cas"', Emu.Session.recordingName(new Uint8Array(0), at).name === 'Recording 09-05.cas');
  const ab = record(s, 'A/B     ');
  check('"A/B": a character a file name can\'t take becomes "_", A_B.CAS', Emu.Session.recordingName(ab.cas, at).name === 'A_B.CAS', Emu.Session.recordingName(ab.cas, at).name);
  const odd = record(s, 'X:Y*?<> ');
  check('every forbidden character becomes "_", the name trimmed', Emu.Session.recordingName(odd.cas, at).name === 'X_Y____.CAS', Emu.Session.recordingName(odd.cas, at).name);
  const two = record(s, 'HELLO   ', 2);
  check('two CSAVEs in one recording: one file named after the first, which says 2 files',
    JSON.stringify(Emu.Session.recordingName(two.cas, at)) === JSON.stringify({ name: 'HELLO.CAS', files: 2 }) && two.blocks === 6, JSON.stringify(Emu.Session.recordingName(two.cas, at)));
  // a second HELLO: the library already has HELLO.CAS
  check('a free name is kept', await s.library.uniqueName('HELLO.CAS') === 'HELLO.CAS');
  await s.library.importMedia('HELLO.CAS', hello.cas);
  check('a second HELLO: "HELLO (2).CAS"', await s.library.uniqueName('HELLO.CAS') === 'HELLO (2).CAS');
  await s.library.importMedia('HELLO (2).CAS', hello.cas);
  check('and a third: "HELLO (3).CAS"', await s.library.uniqueName('HELLO.CAS') === 'HELLO (3).CAS');

  // ---- a tape of several files: which one is playing ----
  s.insertTape('two.cas', two.cas);
  let st = s.tapeStatus();
  check('a 2-file tape: files 2, at the start file 0 (none reached yet)', st.files === 2 && st.file === 0, JSON.stringify([st.file, st.files]));
  const second = [...Emu.casBlocks(two.cas)].filter((b) => b.type === 0)[1].start;
  s.shownMachine.deck.tape.seekByte(second + 1);
  st = s.tapeStatus();
  check('past the second namefile block: file 2 of 2, block 4 of 6', st.file === 2 && st.files === 2 && st.block === 4 && st.blocks === 6, JSON.stringify([st.file, st.files, st.block, st.blocks]));
  s.insertTape('one.cas', hello.cas);
  st = s.tapeStatus();
  check('a 1-file tape: files 1', st.files === 1, JSON.stringify(st.files));

  // ---- ejecting ----
  const seen = [];
  s.on((ev) => seen.push(ev));
  s.shownMachine.deck.setMotor(true);
  frames(s, 3);
  s.tapeStatus();
  const before = s.shownMachine.cpu.totalCycles, frame = s.shownMachine.frameCount;
  check('a tape watch runs while the motor is on', !!s.tapeWatch);
  const had = s.ejectTape();
  check('ejectTape: the deck is empty, \'tape\' emitted, the tape watch cleared', had === true && !s.shownMachine.deck.tape && seen.includes('tape') && s.tapeWatch === null && s.tapeStatus() === null);
  frames(s, 3);
  check('ejected while the motor runs: nothing reset, the motor stays on and the machine runs on (a program reading the tape keeps waiting)',
    s.shownMachine.deck.motor && s.shownMachine.cpu.totalCycles > before && s.shownMachine.frameCount === frame + 3 && s.shownMachine.deck.level() === false);
  check('ejectTape with no tape: false, nothing else', s.ejectTape() === false);

  console.log(fail ? `${fail} failed` : 'all passed');
  process.exitCode = fail ? 1 : 0;
})();
