// Builds the Speech/Sound Pak's two ROM images for verification (stage 2):
//
//   build/pic-7040-510.bin   4 KB  our own TMS7040 firmware (ssc-pic.asm), assembled by our assembler
//   build/sp0256-al2.bin     2 KB  our own SP0256 program (sp0256-asm.js), eight short allophone entries
//
// Neither is a real dump. At run time a user supplies their own copies of both under these names; these exist
// so MAME and the tests can run the same bytes without one, through MAME's checksum-mismatch path (AGENTS.md
// hard rule 1 and tools/mame-diff/lib/).
//
// The SP0256 program is built by sp0256-asm.js, in the chip's own encoding (js/chips/sp0256.js: bits LSB first,
// entry n at $1000 + 2n).
const fs = require('fs'), path = require('path');
const { assembleFile, romImage, loadEmu } = require('../lib/firmware.js');
const { assemble } = require('./sp0256-asm.js');

const HERE = __dirname;

// Where the images are written. The other firmware families keep generated binaries out of the repository
// and build them into a per-run work directory under /tmp (lib/firmware.js's writeRoms takes that path as an
// argument); this follows the same pattern. When lib/workdir.js lands on main, replace this with
// `const WORK = workDir('ssc')` and nothing else changes.
const WORK = process.env.CLOADM_SSC_WORK || '/tmp/mame-diff/ssc';
const OUT = path.join(WORK, 'roms');

// ---- the TMS7040 firmware: a full 4 KB image with its vectors at the top ----
// Two images from one source. `ssc-pic.asm` is the single source of truth and carries the masked value
// ($0C, which sets INT2's enable and flag, not INT3's - Figure 3-16); this function substitutes the IOCNT0
// byte for the INT3-enabled case and asserts that exactly the expected line changed, so the two variants
// cannot drift apart. The assembler's 7000 instruction set takes only literal hex immediates (a symbol after
// %> is rejected), which is why the substitution is textual rather than an EQU.
const PIC_IOCNT0_LINE = /^(IOCNT0_INIT\s+MOVP\s+%>)([0-9A-Fa-f]{2})(,P0\b.*)$/m;
const IOCNT0_MASKED = 0x0C;         // as the source ships: INT3 masked
const IOCNT0_INT3_ENABLED = 0x30;   // INT3 enable (bit 4) + INT3 flag clear (bit 5), Figure 3-16

function buildPic({ iocnt0 = IOCNT0_MASKED } = {}) {
  if (iocnt0 !== IOCNT0_MASKED && iocnt0 !== IOCNT0_INT3_ENABLED) {
    throw new Error(`buildPic: unsupported IOCNT0 value $${iocnt0.toString(16)}; the source is written for $0C`);
  }
  const file = path.join(HERE, 'ssc-pic.asm');
  let src = fs.readFileSync(file, 'utf8');
  if (iocnt0 !== IOCNT0_MASKED) {
    const lines = src.split('\n').filter((l) => PIC_IOCNT0_LINE.test(l));
    if (lines.length !== 1) throw new Error(`ssc-pic.asm: expected one IOCNT0_INIT line, found ${lines.length}`);
    const want = `$${iocnt0.toString(16).toUpperCase().padStart(2, '0')}`;
    src = src.replace(PIC_IOCNT0_LINE, (m, head, val, tail) => {
      if (val.toUpperCase() !== '0C') throw new Error(`ssc-pic.asm: IOCNT0_INIT is $${val}, expected $0C`);
      return head + want.slice(1) + tail;
    });
  }
  const include = (name) => { const f = path.join(HERE, name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
  const res = loadEmu().assemble(src, '7000', { include });
  if (!res.ok) throw new Error(`ssc-pic.asm: ${res.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
  if (iocnt0 !== IOCNT0_MASKED) {
    // the substituted image must differ from the shipped one in exactly the three bytes of MOVP %>nn,P0
    const a = romImage(assembleFile(file, '7000'), 0xF000, 0x1000, 0xFF);
    const b = romImage(res, 0xF000, 0x1000, 0xFF);
    const diff = [...a.keys()].filter((i) => a[i] !== b[i]);
    if (diff.length !== 1) throw new Error(`buildPic: substituting IOCNT0 changed ${diff.length} bytes, expected 1`);
  }
  return romImage(res, 0xF000, 0x1000, 0xFF);
}

// ---- our 6809 firmware as a BASIC-slot image, in two forms ----
// The source ships the bounded WAITBUS (needed with IOCNT0 = $0C, where the card never interrupts) and this
// function builds the INT3 case by substituting an unbounded poll for the marked block. The substitution is
// checked: exactly one block must match, and the two images must differ.
const ASM_WAITBUS_BLOCK = /\* ---- WAITBUS-BOUNDED\n([\s\S]*?)\* ---- WAITBUS-END\n/;
const ASM_WAITBUS_UNBOUNDED = `* ---- WAITBUS-UNBOUNDED: poll $FF7E until the busy bit (7) is set, with no give-up path.
* The card answers every command in the INT3 case, so the wait always ends; a time-out path here would hide a
* difference between the two emulators behind a count instead of failing at the instruction that differed.
WAITBUS LDA     SSC_DATA
        BITA    #$80
        BEQ     WAITBUS
        RTS
`;

function buildAsm({ unbounded = false, mux = false } = {}) {
  const file = path.join(HERE, 'ssc.asm');
  let src = fs.readFileSync(file, 'utf8');
  if (unbounded) {
    const hits = src.match(new RegExp(ASM_WAITBUS_BLOCK.source, 'g')) || [];
    if (hits.length !== 1) throw new Error(`ssc.asm: expected one WAITBUS block, found ${hits.length}`);
    src = src.replace(ASM_WAITBUS_BLOCK, ASM_WAITBUS_UNBOUNDED);
  }
  if (mux) {
    // the sound-mux case: select the cartridge on the CoCo's sound mux before the first command, so the Pak's
    // audio reaches the speaker (see ssc.asm's MUXON and MAME's coco.cpp:555). Marked so the substitution is
    // checked: exactly one START block, and the only change is the added JSR.
    const hits = src.match(/\nSTART   CLR     TIMEOUTS\n/g) || [];
    if (hits.length !== 1) throw new Error(`ssc.asm: expected one START block, found ${hits.length}`);
    src = src.replace(/\nSTART   CLR     TIMEOUTS\n/, '\nSTART   CLR     TIMEOUTS\n        JSR     MUXON\n');
  }
  const include = (name) => { const f = path.join(HERE, name); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
  const res = loadEmu().assemble(src, '6809', { include });
  if (!res.ok) throw new Error(`ssc.asm: ${res.errors.map((e) => `line ${e.line}: ${e.message}`).join('; ')}`);
  return res;
}

// ---- the SP0256 data ----
// The commands ssc.asm sends load allophones 1-8 (and numbers the Pak must ignore). Each entry is a short program of
// its own, so the speech chip runs, raises SBY and waits again within a command: what the Pak's outcome and the
// SBY bit of its status reads show.
const ENTRIES = [
  { name: 'SETMODE mode 0, then RTS: back to standby at once', body: [{ op: 'SETMODE', mode: 0 }, { op: 'RTS' }] },
  { name: 'a voiced load: LOAD_E, repeat 1, pitch 30', body: [{ op: 'SETMODE', mode: 0 }, { op: 'LOAD_E', repeat: 1, fields: [10, 30] }, { op: 'RTS' }] },
  { name: 'an unvoiced load: LOAD_E, repeat 1, pitch 0', body: [{ op: 'SETMODE', mode: 0 }, { op: 'LOAD_E', repeat: 1, fields: [10, 0] }, { op: 'RTS' }] },
  { name: 'SETMODE mode 3 with the repeat\'s high bits, a PAUSE of 49', body: [{ op: 'SETMODE', mode: 3, msb: 3 }, { op: 'PAUSE', repeat: 1 }, { op: 'RTS' }] },
  { name: 'PAGE 1, then RTS', body: [{ op: 'PAGE', page: 1 }, { op: 'RTS' }] },
  { name: 'RTS with no return address: stops at once (SBY)', body: [{ op: 'RTS' }] },
  { name: 'JMP to entry 6\'s code', body: [{ op: 'JMP', to: 'e6' }] },
  { name: 'JSR to a subroutine that returns, then RTS', body: [{ op: 'JSR', to: 'sub' }, { op: 'RTS' }] },
];

function buildSp0256() {
  const prog = [];
  ENTRIES.forEach((e, i) => prog.push({ entry: i + 1, to: `e${i + 1}` }));
  ENTRIES.forEach((e, i) => prog.push({ align: true }, { label: `e${i + 1}` }, ...e.body));
  prog.push({ align: true }, { label: 'sub' }, { op: 'SETMODE', mode: 0 }, { op: 'LOAD_E', repeat: 1, fields: [5, 20] }, { op: 'RTS' });
  return assemble(prog).image;
}

// ssc-tone.asm, our PIC program that plays three tone pairs per command: the tests' and the browser check's
// sound source (it waits on the CoCo's commands, so it is not the MAME audio case: gen-ay.js is).
function toneFirmware() {
  return romImage(assembleFile(path.join(HERE, 'ssc-tone.asm'), '7000'), 0xF000, 0x1000, 0xFF);
}

if (require.main === module) {
  fs.mkdirSync(OUT, { recursive: true });
  const pic = buildPic();
  const sp = buildSp0256();
  // MAME's names, which are what it looks for in the coco_ssc slot (identical in 0.264 and 0.289)
  fs.writeFileSync(path.join(OUT, 'pic-7040-510.bin'), pic);
  fs.writeFileSync(path.join(OUT, 'sp0256-al2.bin'), sp);
  console.log(`wrote ${OUT}: pic-7040-510.bin ${pic.length} bytes, sp0256-al2.bin ${sp.length} bytes`);
}

// The same two images come back in memory for tests and machines, so nothing is read back from disk: the
// bytes a test uses are the bytes the build produced.
module.exports = { buildPic, buildSp0256, toneFirmware, buildAsm, ENTRIES, WORK, OUT, IOCNT0_MASKED, IOCNT0_INT3_ENABLED };
