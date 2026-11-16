// Builds the Speech/Sound Pak's two ROM images for verification (stage 2):
//
//   build/pic-7040-510.bin   4 KB  our own TMS7040 firmware (ssc-pic.asm), assembled by our assembler
//   build/sp0256-al2.bin     2 KB  hand-built SP0256 data exercising each parameter mode
//
// Neither is a real dump. At run time a user supplies their own copies of both under these names; these exist
// so MAME and the tests can run the same bytes without one, through MAME's checksum-mismatch path (AGENTS.md
// hard rule 1 and tools/mame-diff/lib/).
//
// The SP0256 data is generated rather than assembled: the chip's program is a bit stream, not machine code,
// so each allophone entry below is a bit pattern written out by hand from GI's instruction framing (see
// js/chips/sp0256.js for the encoding) and then packed MSB-first, which is the order the chip reads.
const fs = require('fs'), path = require('path');
const { assembleFile, romImage, loadEmu } = require('../lib/firmware.js');

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
// The chip reads a bit stream: the PC counts bits and an instruction may start on any bit. Entry points are
// 16 bits apart (GI sheet 29), and the host loads an allophone number that selects entry n*16. Every entry
// below is 16 bits: one instruction word, so each allophone number is a single, self-contained instruction
// that the -wavwrite comparison can tell apart.
//
// The bits are GI's instruction framing (see js/chips/sp0256.js). This generator writes them as strings so the
// pattern for each entry is readable against the source rather than buried in hex.
const ENTRIES = {
  1: { name: 'RCU: M=0 P=0, repeat 0 (precise + voiced)', bits: '0001' + '00' + '00' },
  2: { name: 'RCU: M=0 P=1, repeat 0 (precise + unvoiced)', bits: '0001' + '01' + '00' },
  3: { name: 'RCU: M=1 P=0, repeat 0 (filter order change)', bits: '0001' + '10' + '00' },
  4: { name: 'RCU: M=1 P=1, repeat 3', bits: '0001' + '11' + '11' },
  5: { name: 'PAG: page 2', bits: '0000' + '0010' },
  6: { name: 'RET with no address: stops the sequencer (SBY)', bits: '0111' },
  7: { name: 'JMP to entry 0', bits: '1110' + '0000' },
  8: { name: 'JSR to entry 0', bits: '1101' + '0000' },
};

// pack a bit string MSB-first into bytes, the order the chip reads (bit b is bit (7 - b % 8) of byte b >> 3)
function packBits(entries, size) {
  const bytes = new Uint8Array(size);
  for (const [n, e] of Object.entries(entries)) {
    const base = Number(n) * 16;                     // entry n lives at bit n*16
    for (let i = 0; i < e.bits.length; i++) {
      if (e.bits[i] !== '1') continue;
      const bit = base + i;
      bytes[bit >> 3] |= 0x80 >> (bit % 8);
    }
  }
  return bytes;
}

function buildSp0256() {
  return packBits(ENTRIES, 0x800);
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
module.exports = { buildPic, buildSp0256, buildAsm, ENTRIES, WORK, OUT, IOCNT0_MASKED, IOCNT0_INT3_ENABLED };
