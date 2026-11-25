// A stand-in for BASIC's cold start, written for CLOADM (no BASIC ROM code or data in it), for the tests that need a
// BASIC program memory and an OK prompt: tests/basic-share.test.js and the browser check's basic-share group.
// Installed in place of a machine's BASIC ROM(s), it does only what load_basic (js/claude/basicload.js) checks:
//   - BASIC's direct-page pointers describe an empty program, as after NEW [CBU p.7]: a zero byte before TXTTAB, the
//     zero end link at TXTTAB, VARTAB = ARYTAB = ARYEND just past it, FRETOP the top of free RAM. The addresses are
//     the dialects' (js/media/basic.js DIALECTS: $19-$22 on the Dragon and the CoCo, $93-$9C on the MC-10);
//   - a cleared text screen with "OK" on its top line (Session's boot check reads it), then an idle loop.
// It reads no keys: LIST typed into it goes nowhere, so a test reads the program back from memory
// (js/media/basic.js listProgram), the text LIST would show.
// build(Emu, id) -> { socket: bytes } for setRoms / a ROM drop, for dragon32, dragon64, coco, coco3 and mc10.
const LAYOUT = {
  dragon32: { start: 0x1E01, fretop: 0x7E00 }, dragon64: { start: 0x1E01, fretop: 0x7E00 },
  coco: { start: 0x2601, fretop: 0x7E00 }, coco3: { start: 0x2601, fretop: 0x7E00 }, mc10: { start: 0x4346, fretop: 0x4E00 },
};
const hex = (v) => `$${v.toString(16).toUpperCase()}`;

function source(id) {
  const L = LAYOUT[id], after = L.start + 2;
  if (id === 'mc10') {
    return `
        ORG     $E000
RESET   SEI
        LDS     #$4FF0
        LDAA    #$40            ; the 6803's RAM control: internal RAM on (it holds BASIC's direct page)
        STAA    $14
        CLR     ${hex(L.start - 1)}
        LDD     #0
        STD     ${hex(L.start)}
        LDD     #${hex(L.start)}
        STD     $93             ; TXTTAB
        LDD     #${hex(after)}
        STD     $95             ; VARTAB
        STD     $97             ; ARYTAB
        STD     $99             ; ARYEND
        LDD     #${hex(L.fretop)}
        STD     $9B             ; FRETOP
        LDX     #$4000
        LDD     #$6060
CLS     STD     0,X
        INX
        INX
        CPX     #$4200
        BNE     CLS
        LDD     #$4F4B          ; OK
        STD     $4000
IDLE    BRA     IDLE
        ORG     $FFFE
        FDB     RESET
`;
  }
  // the CoCo 3: its MMU and GIME the way its BASIC leaves them (task 0 = blocks $38-$3F, the CoCo-compatible mode,
  // video at physical $70400), as tests/basic-load.test.js sets them
  const coco3 = id === 'coco3' ? `
        LDX     #$FFA0
        LDA     #$38
MMU     STA     ,X+
        INCA
        CMPX    #$FFA8
        BNE     MMU
        LDA     #$CE
        STA     $FF90
        LDD     #$E000
        STD     $FF9D
` : '';
  return `
        ORG     $8000
RESET   ORCC    #$50
        LDS     #$7F00
        CLRA
        TFR     A,DP
${coco3}
        STA     $FFC9           ; the SAM's display offset: $0400
        CLR     $FF23
        LDA     #$F8
        STA     $FF22
        LDA     #$04
        STA     $FF23
        CLR     $FF22           ; text mode
        CLR     ${hex(L.start - 1)}
        LDD     #0
        STD     ${hex(L.start)}
        LDD     #${hex(L.start)}
        STD     $0019           ; TXTTAB
        LDD     #${hex(after)}
        STD     $001B           ; VARTAB
        STD     $001D           ; ARYTAB
        STD     $001F           ; ARYEND
        LDD     #${hex(L.fretop)}
        STD     $0021           ; FRETOP
        LDX     #$0400
        LDD     #$6060
CLS     STD     ,X++
        CMPX    #$0600
        BNE     CLS
        LDD     #$4F4B          ; OK
        STD     $0400
IDLE    BRA     IDLE
        ORG     ${id === 'coco3' ? '$FFFE' : '$BFFE'}
        FDB     RESET
`;
}

function build(Emu, id) {
  const p = Emu.profiles[id];
  if (!p || !LAYOUT[id]) throw new Error(`basic-standin: no stand-in for ${id}`);
  const asm = Emu.assemble(source(id), id === 'mc10' ? '6803' : '6809');
  if (!asm.ok) throw new Error(`basic-standin ${id}: ${JSON.stringify(asm.errors)}`);
  const lo = Math.min(...p.roms.map((r) => r.at)), hi = Math.max(...p.roms.map((r) => r.at + r.size));
  const image = new Uint8Array(hi - lo).fill(0x12);   // NOPs between the code and the vector
  for (const s of asm.segments) image.set(s.data, s.addr - lo);
  const out = {};
  for (const r of p.roms) out[r.id] = image.slice(r.at - lo, r.at - lo + r.size);
  return out;
}

module.exports = { build, LAYOUT, source };
