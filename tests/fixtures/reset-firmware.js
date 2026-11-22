// Firmware for the Reset tests (tests/reset.test.js and the browser check's reset group), written for CLOADM.
// Our stand-in for BASIC's reset routine (written for this test, not taken from any ROM): RSTFLG $71 = $55 and a NOP
// at [RSTVEC $72] -> JMP there; else a cold start that clears the screen, prints OK on the top line and waits.
const BASIC = `
        ORG     $8000
RESET   STA     $FFC9           ; the SAM's display offset to $0400 (F1): BASIC's reset routine sets up the SAM first
        LDA     $71
        CMPA    #$55
        BNE     COLD
        LDX     $72
        LDA     ,X
        CMPA    #$12
        BNE     COLD
        JMP     ,X
COLD    ORCC    #$50
        LDS     #$7F00
        CLR     $71
        LDX     #$0400
        LDA     #$60
CLS     STA     ,X+
        CMPX    #$0600
        BNE     CLS
        LDD     #$4F4B
        STD     $0400
HANG    BRA     HANG
        ORG     $BFF2
        FDB     RESET,RESET,RESET,RESET,RESET,RESET,RESET
`;
// A game that takes over Reset, as many machine-code games do: it sets the flag and points the vector at a NOP of its
// own, then fills the screen with G; the warm entry fills it with W. Loaded at $4022 and run there.
const GAME = `
        ORG     $4022
START   ORCC    #$50
        LDS     #$3F00
        LDA     #$55
        STA     $71
        LDX     #WARM
        STX     $72
        LDA     #$47
        BSR     FILL
G1      BRA     G1
WARM    NOP
        LDS     #$3F00
        LDA     #$57
        BSR     FILL
W1      BRA     W1
FILL    LDX     #$0400
F1      STA     ,X+
        CMPX    #$0600
        BNE     F1
        RTS
`;

// -> { basic, basic64: the two 16K ROM images (the second all NOPs), game: the game's segments, gameBin: it as a
// DragonDOS binary (header $55, type 2, load, length, exec, $AA) }
function build(Emu) {
  const asm = (src) => { const r = Emu.assemble(src, '6809'); if (!r.ok) throw new Error(JSON.stringify(r.errors)); return r; };
  const basic = new Uint8Array(0x4000).fill(0x12);
  for (const sg of asm(BASIC).segments) if (sg.addr >= 0x8000 && sg.addr < 0xC000) basic.set(sg.data, sg.addr - 0x8000);
  const game = asm(GAME).segments, g = game[0];
  const gameBin = Uint8Array.from([0x55, 0x02, g.addr >> 8, g.addr & 0xFF, g.data.length >> 8, g.data.length & 0xFF, g.addr >> 8, g.addr & 0xFF, 0xAA, ...g.data]);
  return { basic, basic64: new Uint8Array(0x4000).fill(0x12), game, gameBin };
}
module.exports = { BASIC, GAME, build };
