// Cassette firmware for the Dragon/CoCo family (written for CLOADM), installed in place of the BASIC ROM:
//   csave.asm  writes a namefile, a data and an end-of-file block through the DAC, as BASIC's writer does
//   cload.asm  reads blocks from the cassette input, as BASIC's reader does, and reports what it read
// and the same pair for the MC-10 / Matra Alice, whose CPU is a 6803 and whose cassette is P20 / P24 of the
// 6803's port 2 with no motor relay:
//   csave6803.asm, cload6803.asm
// tests/tape.test.js runs them on our machines; run-tape.js runs them in MAME.
const path = require('path');
const { loadEmu, assembleFile, romImage } = require('../lib/firmware');

// the firmware as the profile's ROM slots; the 6809 pair is a 16K image at $8000 (Dragon 64: both banks the
// same) and a 32K one on the CoCo 3, whose BASIC socket spans $8000-$FFFF; the 6803 pair an 8K image at $E000
// in the MC-10's single BASIC slot. The image covers the profile's whole ROM area, so the slot slices fit.
function firmware(profileId, file) {
  const Emu = loadEmu(), profile = Emu.profiles[profileId];
  const is6803 = file.includes('6803');
  const asm = assembleFile(path.join(__dirname, file), is6803 ? '6803' : '6809');
  const base = Math.min(...profile.roms.map((sl) => sl.at));
  const end = Math.max(...profile.roms.map((sl) => sl.at + sl.size));
  const img = romImage(asm, base, end - base, is6803 ? 0x01 : 0x12);
  const slots = {}, files = {};
  for (const sl of profile.roms) slots[sl.id] = img.slice(sl.at - base, sl.at - base + sl.size);
  for (const sl of profile.roms) for (const f of sl.files) files[f] = slots[sl.id];
  return {
    asm, slots, files, system: profile.mame, haltPc: asm.symbols.get('HALT'),
    machine: (config = {}) => { const m = Emu.createMachine(profileId, config); m.setRoms(slots); m.reset(true); return m; },
  };
}

// the byte stream csave.asm writes, built here from the format, independently of the firmware
function csaveStream() {
  const block = (type, data) => {
    let sum = (type + data.length) & 0xFF;
    for (const d of data) sum = (sum + d) & 0xFF;
    return [0x3C, type, data.length, ...data, sum, 0x55];
  };
  const leader = () => new Array(128).fill(0x55);
  const name = [...'CLOADM  '].map((c) => c.charCodeAt(0)).concat([0x02, 0x00, 0x00, 0x30, 0x00, 0x30, 0x00]);
  const data = Array.from({ length: 255 }, (_, i) => (11 + 37 * i) & 0xFF);
  return Uint8Array.from([...leader(), ...block(0x00, name), ...leader(), ...block(0x01, data), ...leader(), ...block(0xFF, [])]);
}

// for the regression gate (tests/regress.test.js): the instruction trace of a firmware run on our machine;
// for the regression gate (tests/regress.test.js): the instruction trace of a firmware run on our machine;
// the reader reads the tape the writer writes
const REGS6809 = ['pc', 'a', 'b', 'x', 'y', 'u', 's', 'dp', 'cc'].map((name) => ({ name }));
const REGS6803 = ['pc', 'a', 'b', 'x', 's', 'cc'].map((name) => ({ name }));
function trace(profileId, file) {
  const f = firmware(profileId, file), Emu = loadEmu();
  const is6803 = file.includes('6803');
  const load = file.startsWith('cload');
  return {
    regs: is6803 ? REGS6803 : REGS6809, haltPc: f.haltPc,
    // HALT comes after about 1,076,000 (csave) and 1,500,000 (cload: the tape is played with 2 s of silence at
    // its start and 1 s after the namefile, js/media/tape.js) instructions on the 6809, and 1,165,000 (csave6803)
    // and 1,247,000 (cload6803) on the 6803; cloadm.asm about 2,920,000 (its waits, and 4 s at the end of the tape)
    instructions: is6803 ? 1400000 : file === 'cloadm.asm' ? 3200000 : load ? 1700000 : 1100000,
    machine: () => {
      // the MC-10 is compared at its base 4K fitting, which MAME's mc10 uses by default
      const m = f.machine(is6803 ? { ram: 4 } : {});
      // cloadm.asm reads the image with one-byte leaders, which loads only with the leaders js/media/tape.js makes up
      if (file === 'cloadm.asm') m.deck.insert(new Emu.Tape(playbackTapes().short, m.tickHz, 'short.cas', m.profile.tape));
      else if (load) m.deck.insert(new Emu.Tape(csaveStream(), m.tickHz, 'csave.cas', m.profile.tape));
      return m;
    },
  };
}

// ---- cassette playback (gaps.asm, cloadm.asm; run-playback.js) ----
// .CAS images that differ in their leaders and in how many files they hold: what a player adds around blocks
// shows in gaps.asm's table, and whether that lets a CLOADM-style reader find every block in cloadm.asm's. Data
// bytes are arbitrary.
function playbackTapes() {
  const block = (type, data) => {
    let sum = (type + data.length) & 0xFF;
    for (const d of data) sum = (sum + d) & 0xFF;
    return [0x3C, type, data.length, ...data, sum, 0x55];
  };
  const lead = (n) => new Array(n).fill(0x55);
  const nf = (name, type, ascii, gap) => block(0x00, [...name.padEnd(8)].map((c) => c.charCodeAt(0)).concat([type, ascii, gap, 0x0E, 0x00, 0x0E, 0x00]));
  const data = (n, k) => block(0x01, Array.from({ length: n }, (_, i) => (k * 31 + i * 7) & 0xFF));
  const eof = block(0xFF, []);
  return {
    standard: Uint8Array.from([...lead(128), ...nf('STD', 2, 0, 0), ...lead(128), ...data(255, 1), ...data(100, 2), ...eof]),
    short: Uint8Array.from([...lead(1), ...nf('SHORT', 2, 0, 0), ...lead(1), ...data(255, 1), ...data(100, 2), ...eof]),
    gapped: Uint8Array.from([...lead(128), ...nf('GAPPED', 1, 0xFF, 0xFF), ...lead(128), ...data(60, 1), ...lead(128), ...data(60, 2), ...lead(128), ...eof]),
    twofiles: Uint8Array.from([...lead(2), ...nf('ONE', 2, 0, 0), ...lead(2), ...data(40, 1), ...eof, ...lead(2), ...nf('TWO', 2, 0, 0), ...lead(2), ...data(40, 2), ...eof]),
  };
}
// The two firmwares and how to read their tables (at $1000, up to U in HALT)
const PLAYBACK = {
  gaps: { file: 'gaps.asm', seconds: 120,
    // [{ edges, gap }]: gap in loop counts
    parse: (b) => { const out = []; for (let i = 0; i + 5 <= b.length; i += 5) out.push({ edges: (b[i] << 8) | b[i + 1], gap: (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4] }); return out; },
    show: (t) => t.map((e) => `${e.edges}e/${e.gap}`).join(' '),
    // the same silences: as many, in the same places, each as long within 0.5% (and 16 counts: where in its
    // 22-cycle loop the firmware sees the edge, and where in a half cycle the silence starts). The runs between
    // them are shown, not compared: MAME rewrites the leaders of a .CAS file (128 bytes in front of every
    // namefile and the block after it, longer ones shortened), adds a $55 to every block and lengthens runs of
    // $55 between blocks, where we play the file's bytes and only make up leaders that are too short
    // (js/media/tape.js; docs/verification.md, "Deviations from MAME"). That the same blocks are read is what
    // cloadm.asm's comparison shows.
    same: (a, b) => a.length === b.length && a.length > 0 && a.every((e, i) => i === a.length - 1 || Math.abs(e.gap - b[i].gap) <= Math.max(16, e.gap * 0.005)),
    what: 'silences' },
  cloadm: { file: 'cloadm.asm', seconds: 120,
    // [{ type, len, ok, first }]: the blocks read, in order
    parse: (b) => { const out = []; for (let i = 0; i + 4 <= b.length; i += 4) out.push({ type: b[i], len: b[i + 1], ok: b[i + 2], first: b[i + 3] }); return out; },
    show: (t) => t.map((e) => `${e.type.toString(16)}:${e.len}${e.ok ? '' : '!'}`).join(' '),
    same: (a, b) => a.length === b.length && a.every((e, i) => e.type === b[i].type && e.len === b[i].len && e.ok === b[i].ok && e.first === b[i].first),
    what: 'blocks read' },
};
// a playback firmware's table on our machine: the firmware in the ROM slots, the tape in the deck, run to HALT
function playbackTable(kind, profileId, slots, bytes) {
  const Emu = loadEmu(), k = PLAYBACK[kind];
  const m = Emu.createMachine(profileId, {});
  m.setRoms(slots); m.reset(true);
  m.deck.insert(new Emu.Tape(bytes, m.tickHz, `${kind}.cas`, m.profile.tape));
  const halt = assembleFile(path.join(__dirname, k.file), '6809').symbols.get('HALT');
  for (let f = 0; f < 200 * m.fps && m.cpu.pc !== halt; f++) m.runFrame();
  return m.cpu.pc === halt ? k.parse(m.ram.slice(0x1000, m.cpu.u)) : null;
}

module.exports = { firmware, csaveStream, trace, playbackTapes, PLAYBACK, playbackTable };
