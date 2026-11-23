/*
 * No-ROM support shared by the machine families: a text console for the 32x16 VDG text screen,
 * and stub firmware assembled from source with the project's own assembler.
 *
 * The stub provides the BASIC ROM's console entry points (POLCAT / CHROUT) as PC hooks, so machine-
 * code programs that print and read keys work without the real ROMs. Everything else in the stub ROM
 * is RTS, so stray calls into "ROM" return.
 */
import { assemble } from '../asm/assembler.js';

// 32x16 text screen at `base` in VDG character codes; cursor kept by get/set callbacks
// The VDG's text screen has only the chip's own codes, so a letter outside ASCII (the "o" with an acute in
// "Prologica", as the CP 400 is really written) is folded to its unaccented ASCII letter as it is drawn,
// never dropped. Decompose, keep the base letter, discard combining marks; a symbol with no ASCII base
// (an inverted question mark, a snowman) draws nothing. Extending the character set is not an option: the
// real ROM's set is its own and the stub must not invent glyphs.
const fold = (ch) => ch.normalize('NFD').replace(/[̀-ͯ]/g, '');

class TextConsole {
  constructor(ram, base, getCursor, setCursor) {
    this.ram = ram; this.base = base; this.getCursor = getCursor; this.setCursor = setCursor;
  }
  putChar(c) {
    const ram = this.ram, b = this.base, end = b + 0x200;
    let pos = this.getCursor();
    if (pos < b || pos >= end) pos = b;
    if (c === 12) { ram.fill(0x60, b, end); pos = b; }
    else if (c === 13) pos = b + (((pos - b) & ~31) + 32);
    else if (c === 8) { if (pos > b) { pos--; ram[pos] = 0x60; } }
    else if (c >= 32) {
      // non-ASCII (Latin-1 accents and beyond): fold to the ASCII letter, or draw nothing. Only a fold that
      // actually produced ASCII is kept, so an inverted question mark (no combining mark, no ASCII base)
      // draws nothing rather than some other glyph.
      if (c > 0x7E) {
        const ascii = fold(String.fromCharCode(c));
        if (!ascii || ascii.charCodeAt(0) > 0x7E) { this.setCursor(pos); return; }
        c = ascii.charCodeAt(0);
      }
      let v = c & 0x7F;
      if (v >= 0x60) v -= 0x60;           // lower case shown inverted
      else if (v < 0x40) v += 0x40;       // punctuation and digits
      ram[pos++] = v;
    }
    if (pos >= end) { ram.copyWithin(b, b + 32, end); ram.fill(0x60, end - 32, end); pos -= 32; }
    this.setCursor(pos);
  }
  print(text) { for (const ch of text) this.putChar(ch.charCodeAt(0)); }
}

const banner = (name, extra) =>
  `${name.toUpperCase()}\rNO ROM LOADED - BUILT-IN STUB\r\r${extra}\rON THE SCREEN, OR LOAD THE\rROMS TO RUN BASIC.\r\r`;

// Color BASIC / Dragon BASIC style stub for the 6809 machines. ROM call vectors at $A000 (POLCAT,
// CHROUT, ...), an idle loop echoing keys that also carries out typed POKE address,value lines (so the
// POKE book works without ROMs; other lines are ignored), interrupt handlers that acknowledge the PIAs
// (and, on the CoCo 3, the GIME), and hardware vectors. opts: { size, base, gime }
function stub6809Source({ gime = false } = {}) {
  return `
POLCAT  EQU     $B100
CHROUT  EQU     $B110
CSRDON  EQU     $B120
BLKIN   EQU     $B130
BLKOUT  EQU     $B140
JOYIN   EQU     $B150
WRTLDR  EQU     $B160
      ORG     $A000
      FDB     POLCAT,CHROUT,CSRDON,BLKIN,BLKOUT,JOYIN,WRTLDR
      ORG     $AFF0
RESET   JMP     IDLE            ; (hooked: initialises the machine)
LIDX    EQU     $02DC           ; line length; the line from $02DD (Color BASIC's line buffer)
LBUF    EQU     $02DD
NUMT    EQU     $02D8           ; number being read
NUM2    EQU     $02DA
PADDR   EQU     $02D6
      ORG     $B020
IDLE    JSR     [$A000]
      BEQ     IDLE
      JMP     KEY
IDLEE                           ; (the end of the idle loop: Machine.atStubPrompt)
      ORG     $B200
KEY     PSHS    A
      JSR     [$A002]         ; echo
      PULS    A
      LDB     LIDX
      CMPA    #13
      BEQ     LINE
      CMPA    #8
      BNE     STORE
      TSTB                    ; backspace
      BEQ     NEXT
      DEC     LIDX
      BRA     NEXT
STORE   CMPA    #32             ; other control keys (CLEAR, ...) are not part of the line
      BLO     NEXT
      CMPB    #64
      BHS     NEXT
      LDX     #LBUF
      ABX
      STA     ,X
      INC     LIDX
      BRA     NEXT
LINE    LDX     #LBUF
      ABX
      CLR     ,X              ; end of line
      CLR     LIDX
      LDX     #LBUF
      BSR     SKIP
      LDY     #PKW
KW      LDA     ,Y+
      BEQ     KWOK
      CMPA    ,X+
      BNE     NEXT
      BRA     KW
KWOK    BSR     SKIP
      BSR     NUM
      STD     PADDR
      BSR     SKIP
      LDA     ,X+
      CMPA    #',
      BNE     NEXT
      BSR     SKIP
      BSR     NUM
      STB     [PADDR]
      LDX     #OKMSG
OKL     LDA     ,X+
      BEQ     NEXT
      PSHS    X
      JSR     [$A002]
      PULS    X
      BRA     OKL
NEXT    JMP     IDLE
SKIP    LDA     ,X
      CMPA    #32
      BNE     SKIPX
      LEAX    1,X
      BRA     SKIP
SKIPX   RTS
NUM     LDD     #0              ; decimal number at X -> D
NUML    STD     NUMT
      LDB     ,X
      SUBB    #'0
      BLO     NUMX
      CMPB    #9
      BHI     NUMX
      LEAX    1,X
      PSHS    B
      LDD     NUMT
      ASLB
      ROLA
      STD     NUM2
      ASLB
      ROLA
      ASLB
      ROLA
      ADDD    NUM2
      ADDB    ,S+
      ADCA    #0
      BRA     NUML
NUMX    LDD     NUMT
      RTS
PKW     FCC     "POKE"
      FCB     0
OKMSG   FCC     "OK"
      FCB     13,0
PROMPTE                         ; (the end of the line editor: Machine.atStubPrompt)
      ORG     $B040
IRQ     LDA     $FF02           ; acknowledge PIA0
      LDA     $FF00
${gime ? '        LDA     $FF92           ; and the GIME' : ''}
      RTI
      ORG     $B050
FIRQ    LDA     $FF22           ; acknowledge PIA1
      LDA     $FF20
${gime ? '        LDA     $FF93           ; and the GIME' : ''}
      RTI
${gime ? `        ORG     $FFF2           ; CoCo 3: hardware vectors point at the secondary vectors in $FExx
      FDB     $FEEE,$FEF1,$FEF4,$FEF7,$FEFA,$FEFD,RESET` : `        ORG     $BFF2           ; seen at $FFF2-$FFFF; RAM vectors at $0100 as in Color BASIC
      FDB     $0100,$0103,$010F,$010C,$0106,$0109,RESET`}
      END`;
}

// MC-10 stub: entry points at Micro Color BASIC's documented POLCAT/CHROUT addresses
function stub6803Source() {
  return `
POLCAT  EQU     $F883
CHROUT  EQU     $F9C6
      ORG     $E000
RESET   NOP                     ; (hooked: initialises the machine, then continues at IDLE)
      NOP
      NOP
IDLE    JSR     POLCAT
      BEQ     IDLE
      JSR     CHROUT
      BRA     IDLE
IDLEE                           ; (the end of the idle loop: Machine.atStubPrompt)
      ORG     $E010
RETI    RTI
      ORG     $FFEE
      FDB     RETI,RETI,RETI,RETI,RETI,RETI,RETI,RETI,RESET
      END`;
}

// assemble a stub into a ROM image of `size` bytes at `base`, unused bytes = RTS
const cache = new Map();
function stubRom(cpu, size, base, opts = {}) {
  const key = JSON.stringify([cpu, size, base, opts]);
  if (cache.has(key)) return cache.get(key);
  const r = assemble(cpu === '6803' ? stub6803Source() : stub6809Source(opts), cpu);
  if (!r.ok) throw new Error('stub firmware: ' + r.errors.map((e) => `line ${e.line}: ${e.message}`).join('; '));
  const rom = new Uint8Array(size).fill(0x39);
  for (const s of r.segments) for (let i = 0; i < s.data.length; i++) {
    const a = s.addr + i - base;
    if (a >= 0 && a < size) rom[a] = s.data[i];
  }
  const out = { rom, symbols: r.symbols };
  cache.set(key, out);
  return out;
}

export { TextConsole, stubRom, banner, basicCursor };

// The text screen cursor's cell on the 6809 families: BASIC's own ROM variable $0088-$0089, which the built-in
// firmware imitates as its console's position (docs/game-development.md). Every program that prints through CHROUT
// leaves it where the next character goes, and a program marks that cell with a block (our LIZA, and BASIC's ROM's
// cursor); a reader counting semigraphics blocks must not read that block as part of a picture. One rule, used by
// both machines that have it (js/machines/sam.js and js/machines/coco3.js), so they cannot disagree.
function basicCursor(ram) { return (ram[0x88] << 8) | ram[0x89]; }
