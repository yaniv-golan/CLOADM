// Builds examples/demo.bin (DragonDOS binary). Run: node tools/build-demo.js
// Hand-encoded 6809 with a tiny two-pass label resolver.
const fs = require('fs');
const path = require('path');

const ORG = 0x4000;
function assemble(prog) {
  const labels = {};
  for (let pass = 0; pass < 2; pass++) {
    const out = [];
    for (const item of prog) {
      const pc = ORG + out.length;
      if (typeof item === 'string') { labels[item] = pc; continue; }
      if (typeof item === 'function') { out.push(...item(pc, labels, pass)); continue; }
      out.push(...item);
    }
    if (pass === 1) return out;
  }
}
const lbl = (name) => (pc, L, pass) => { const v = pass ? L[name] : 0; return [v >> 8, v & 0xFF]; };
const br = (op, name) => (pc, L, pass) => { const t = pass ? L[name] : pc + 2; const o = t - (pc + 2); if (pass && (o < -128 || o > 127)) throw new Error('branch range ' + name); return [op, o & 0xFF]; };
const ext = (op, a) => [op, a >> 8, a & 0xFF];
const str = (s) => [...s].map((c) => c.charCodeAt(0));

const FRAME = 0x7000, ROW = 0x7001, TMP = 0x7002;
const BRA = 0x20, BNE = 0x26, BEQ = 0x27, BPL = 0x2A;

const prog = [
  'start',
  // print message through the ROM CHROUT vector
  [0x8E], lbl('msg'),                    // LDX #msg
  'pr',
  [0xA6, 0x80],                          // LDA ,X+
  br(BEQ, 'key'),
  [0xAD, 0x9F, 0xA0, 0x02],              // JSR [$A002]
  br(BRA, 'pr'),
  'key',
  [0xAD, 0x9F, 0xA0, 0x00],              // JSR [$A000]  (POLCAT)
  br(BEQ, 'key'),
  // graphics: CG6 128x192 4-colour at $0E00
  [0x1A, 0x50],                          // ORCC #$50
  ext(0xB7, 0xFFC0), ext(0xB7, 0xFFC3), ext(0xB7, 0xFFC5),           // SAM V = 110
  ext(0xB7, 0xFFC7), ext(0xB7, 0xFFC9), ext(0xB7, 0xFFCB),           // SAM F = 7 -> $0E00
  ext(0xB7, 0xFFCC), ext(0xB7, 0xFFCE), ext(0xB7, 0xFFD0), ext(0xB7, 0xFFD2),
  [0x86, 0xE0], ext(0xB7, 0xFF22),       // LDA #$E0 ; STA $FF22  (A/G, GM=110, CSS=0)
  ext(0x7F, FRAME),                      // CLR FRAME
  'main',
  ext(0xB6, 0xFF02),                     // LDA $FF02   clear FS flag
  'vs',
  ext(0xB6, 0xFF03),                     // LDA $FF03
  br(BPL, 'vs'),
  // tone: DAC follows frame counter
  ext(0xB6, FRAME), [0x48, 0x48], [0x84, 0xFC], ext(0xB7, 0xFF20),   // LDA FRAME; ASLA; ASLA; ANDA #$FC; STA $FF20
  [0x8E, 0x0E, 0x00],                    // LDX #$0E00
  ext(0x7F, ROW),                        // CLR ROW
  'row',
  ext(0xB6, ROW), [0x44, 0x44, 0x44],    // LDA ROW ; LSRA x3
  ext(0xBB, FRAME),                      // ADDA FRAME
  ext(0xB7, TMP),                        // STA TMP
  [0xC6, 0x00],                          // LDB #0  (column group 0..3)
  'grp',
  [0x34, 0x04],                          // PSHS B
  [0xEB, 0xE4],                          // ADDB ,S  (B = 2*grp) -- spread colours
  ext(0xFB, TMP),                        // ADDB TMP
  [0xC4, 0x03],                          // ANDB #3
  [0x10, 0x8E], lbl('table'),            // LDY #table
  [0xE6, 0xA5],                          // LDB B,Y
  [0x1F, 0x98],                          // TFR B,A
  [0xED, 0x81], [0xED, 0x81], [0xED, 0x81], [0xED, 0x81],            // STD ,X++ x4  (8 bytes)
  [0x35, 0x04],                          // PULS B
  [0x5C],                                // INCB
  [0xC1, 0x04],                          // CMPB #4
  br(BNE, 'grp'),
  ext(0x7C, ROW),                        // INC ROW
  ext(0xB6, ROW), [0x81, 192],           // LDA ROW ; CMPA #192
  br(BNE, 'row'),
  ext(0x7C, FRAME),                      // INC FRAME
  // CSS toggles every 64 frames
  ext(0xB6, FRAME), [0x84, 0x40], [0x44, 0x44, 0x44], [0x8A, 0xE0], ext(0xB7, 0xFF22),
  // any key returns to text screen? keep animating
  [0x7E], lbl('main'),                  // JMP main
  'table', [0x00, 0x55, 0xAA, 0xFF],
  'msg', str('DRAGON 64 EMULATOR DEMO\r\rTHIS 6809 PROGRAM PRINTS VIA\rTHE CHROUT VECTOR, THEN DRAWS\rCOLOUR BARS IN 128X192 MODE.\r\rPRESS ANY KEY...'), [0],
];

const code = assemble(prog);
const hdr = [0x55, 0x02, ORG >> 8, ORG & 0xFF, code.length >> 8, code.length & 0xFF, ORG >> 8, ORG & 0xFF, 0xAA];
const out = path.join(__dirname, '../examples/demo.bin');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from([...hdr, ...code]));
console.log(`wrote ${out} (${code.length} bytes at $${ORG.toString(16)})`);
