/*
 * MC6845 / HD6845S CRT controller (CRTC).
 *
 * Knows nothing about machines. The machine clocks it one character period at a time (clockChar(), or
 * clockLine() for a whole character line) and reads its outputs: display enable, the character address
 * MA and raster address RA for the line begun, the cursor column, and the hsync/vsync lines.
 *
 * The register set and its geometry are the Motorola MC6845 data sheet's (ADM30A, 1977), as MAME's
 * mc6845.cpp implements them. The HD6845S differences are the Hitachi HD6845S data sheet's, which MAME
 * models in hd6845s_device:
 *   - R12/R13 (start address) can be read back; the MC6845's cannot;
 *   - R3's high nibble is the vertical sync width in lines; the MC6845 syncs for a whole line;
 *   - a cursor whose start raster is greater than its end raster is not drawn; the MC6845 draws a
 *     wrapping, split cursor.
 *
 * Registers (written through an address latch and a data port):
 *   R0  horizontal total            characters per line, minus one
 *   R1  horizontal displayed        characters of active display per line
 *   R2  horizontal sync position    character at which HS goes low
 *   R3  sync widths                 low nibble: HS width in characters (0 = 16); high nibble (HD6845S): VS
 *                                   width in lines
 *   R4  vertical total              character rows per frame, minus one
 *   R5  vertical total adjust       extra scanlines added after the last character row
 *   R6  vertical displayed          character rows of active display
 *   R7  vertical sync position      character row at which VS goes low
 *   R8  mode control                interlace and skew: not modelled. Bits 1-0 interlace; on the HD6845S bits 5-4
 *                                   display skew and 7-6 cursor skew (0-2 characters, 3 = non-output: from the
 *                                   HD6845S data sheet's R8 table as recalled; the data sheet was not available to
 *                                   check, no page reference). The Dragon
 *                                   64 Plus's own set-up (Compusense, R8 = $A2) is non-interlace with display and
 *                                   cursor skew 2, which here, as in MAME 0.264, does not move the picture
 *   R9  maximum raster address      the last raster line of a character row
 *   R10 cursor start raster         bits 5-6: blink mode; bits 0-4: the cursor's first raster line
 *   R11 cursor end raster           the cursor's last raster line
 *   R12/R13 start address (MA)      where the display starts in video memory
 *   R14/R15 cursor address (MA)
 *   R16/R17 light pen               read only (latched from MA; no light pen on these machines)
 *
 * Timing, MAME mc6845.cpp handle_line_timer(): a frame is R4+1 character rows plus R5 extra scanlines;
 * RA runs 0..R9 within a row (R9+1 lines per row); the display rows are 0..R6-1, and at the transition
 * into row R6 display enable goes off and MA reloads to R12/R13; VS goes low at the transition into row
 * R7; MA advances by R1 at the end of every character row. HS is low from character R2 for R3's low
 * nibble (16 when 0).
 *
 * The state is plain data, so a snapshot holds the registers, counters and outputs and nothing else.
 */

const REGS = 18;
// the data sheet's field widths: R4, R6 and R7 are seven bits, R5 and R9 five, R10 seven (the blink bits
// live in its top two), R11 five, and R12/R14 keep six bits on their high byte. R8 is a full byte.
const MASK = [0xFF, 0xFF, 0xFF, 0xFF, 0x7F, 0x1F, 0x7F, 0x7F, 0xFF, 0x1F, 0xFF, 0x1F, 0x3F, 0xFF, 0x3F, 0xFF, 0xFF, 0xFF];
// the power-on values MAME starts from: the chip's own are undefined, and a machine programs them all
// before it displays, so these keep one that has not yet done so harmless
const POWER_ON = [0x3F, 0x28, 0x2D, 0x0E, 0x26, 0x00, 0x19, 0x1E, 0x00, 0x07, 0x60, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

class MC6845 {
  constructor() { this.reset(); }

  // Power-on: the registers hold their power-on values, the counters start at the beginning of a
  // frame, and the display is off until the first frame has run its course. A machine resets the CRTC
  // together with the CPU, mid-field on hardware; starting a frame is the state the first programmed
  // frame settles into. The display stays off for that first frame (lineEnable false, as MAME's
  // m_line_enable_ff in mc6845.cpp device_reset()); the data sheet has every output low after reset.
  reset() {
    this.reg = Uint8Array.from(POWER_ON);
    this.dispStart = 0;          // R12/R13 as one 14-bit address
    this.latch = 0;              // the register address latch (the address port's low five bits)
    this.hCounter = 0;           // the character counter within the line (0..R0)
    this.rowCounter = 0;         // the character row counter (0..R4)
    this.raster = 0;             // RA: the scanline within the character row (0..R9)
    this.adjustCounter = 0;      // scanlines of R5's vertical total adjust already spent
    this.adjustActive = false;   // inside the vertical total adjust, past the last character row
    this.lineAddress = 0;        // MA at the start of the current character row (dispStart at reset)
    this.lineEnable = false;     // display enable is off until the first frame restarts (see above)
    this.ma = 0;                 // the character address presented for the current line
    this.de = false;             // display enable
    this.hs = true;              // horizontal sync (active low: true = not syncing)
    this.vs = true;              // vertical sync (active low)
    this.vsActive = false;
    this.vsWidth = 0;            // lines counted into the current VS pulse
    this.cursorX = -1;           // the cursor's column in the line begun, or -1
    this.cursor = false;         // the cursor output for the current line
    this.lightPen = 0;
    // the counters are already at the first line of a frame: the first character must present it, not
    // advance to it (tick() would move RA from 0 to 1)
    this.started = false;
    this.lineAddress = this.dispStart;
    // frame boundary and cursor blink state (mc6845.cpp handle_line_timer/update_cursor_state): counted
    // here so a machine that draws a whole screen per frame (the Dragon 64 Plus) knows when to draw, and so
    // the blink bits in R10 behave as MAME's
    this.frameStarts = 0;
    this.cursorState = false;     // blink off until the first frame boundary sets it (MAME's m_cursor_state)
    this.cursorBlinkCount = 0;
  }

  // ---- register access ----
  // the address port (RS low): the register the next data access reads or writes
  writeAddress(v) { this.latch = v & 0x1F; }
  writeRegister(v) {
    const r = this.latch;
    if (r >= REGS) return;
    this.reg[r] = v & MASK[r];
    if (r === 12 || r === 13) this.dispStart = ((this.reg[12] & 0x3F) << 8) | this.reg[13];
  }
  // a read of the register port: the HD6845S returns R12-R15 (the MC6845 cannot) and the latched light
  // pen address in R16/R17, clearing the latch; every other register reads as 0
  readRegister() {
    const r = this.latch;
    if (r >= 12 && r <= 15) return this.reg[r];
    if (r === 16) { const v = (this.lightPen >> 8) & 0xFF; this.lightPen &= 0xFF; return v; }
    if (r === 17) return this.lightPen & 0xFF;
    return 0;
  }
  // the HD6845S has none of the status-register bits (VBLANK, light pen, UPDATE ready): it reads 0. The
  // Dragon 64 Plus reads DE from its own port instead (de_r()).
  readStatus() { return 0; }

  // ---- the clock ----
  // One character period. The machine calls this at the CRTC's character clock; a whole character line is
  // clockLine(). MA/RA/DE/cursor are presented for the whole line: the counters advance at its first
  // character, before the outputs are read.
  clockChar() {
    if (this.hCounter === 0) { if (this.started) this.tick(); else this.started = true; this.beginLine(); }
    const hsWidth = (this.reg[3] & 0x0F) || 0x10;
    this.hs = !(this.hCounter >= this.reg[2] && this.hCounter < this.reg[2] + hsWidth);
    this.de = this.lineEnable && this.hCounter < this.reg[1];
    if (++this.hCounter > this.reg[0]) this.hCounter = 0;
  }
  // a whole character line: R0+1 character periods
  clockLine() { for (let i = 0; i <= this.reg[0]; i++) this.clockChar(); }

  // the line's outputs, at its first character. MA (MAME's m_current_disp_addr, which draw_scanline()
  // presents) is the start address plus the displayed rows passed so far, so it reloads to R12/R13 once the
  // row counter reaches R6 (MAME's match_line()) and after the frame. R12/R13 written mid-frame therefore
  // shows from the next line.
  beginLine() {
    this.ma = this.rowCounter < this.reg[6] ? (this.dispStart + this.rowCounter * this.reg[1]) & 0x3FFF : this.dispStart;
    this.vs = !this.vsActive;
    this.cursorX = -1;
    if (!this.lineEnable) { this.cursor = false; return; }
    const cur = ((this.reg[14] & 0x3F) << 8) | this.reg[15];
    if (cur >= this.lineAddress && cur < this.lineAddress + this.reg[1]) this.cursorX = cur - this.lineAddress;
    const start = this.reg[10] & 0x1F, end = this.reg[11] & 0x1F;
    // HD6845S: a start raster past the end raster draws no cursor at all (the MC6845 wraps)
    this.cursor = this.cursorX >= 0 && start <= end && this.raster >= start && this.raster <= end;
  }
  // move to the next line: the VS pulse counts its lines, then RA and the row counter advance; the
  // vertical total adjust is checked in the same line (MAME's handle_line_timer does both in one
  // callback: it advances the counters, then spends or ends the adjust).
  tick() {
    // The vertical sync pulse (rowEvents starts it at the transition into row R7) lasts R3's high nibble
    // lines. MAME counts it in a four-bit counter compared after incrementing (mc6845.cpp
    // handle_line_timer: (m_vsync_width_counter + 1) & 0x0F == vsync_width), so the pulse covers the R7
    // line and the lines up to the match - i.e. width lines, and a programmed width of 0 means 16 (the
    // counter wraps). The data sheet: R3's high nibble is the vertical sync width in lines, "0" being the
    // maximum.
    if (this.vsActive) {
      this.vsWidth = (this.vsWidth + 1) & 0x0F;
      if (this.vsWidth === ((this.reg[3] >> 4) & 0x0F)) this.vsActive = false;
    }
    if (this.raster === this.reg[9]) {
      this.raster = 0;
      this.rowCounter++;
      if (this.rowCounter > this.reg[4]) this.rowCounter = 0;   // seven bits; R4 is 0x7F at most
      this.lineAddress = (this.lineAddress + this.reg[1]) & 0x3FFF;
      // the vertical total adjust begins after the last character row (row R4), before row 0's events
      if (this.rowCounter === 0) { this.adjustActive = true; this.adjustCounter = 0; }
      this.rowEvents();
    } else this.raster++;
    if (this.adjustActive) {
      if (this.adjustCounter >= this.reg[5]) {
        this.adjustActive = false; this.adjustCounter = 0;
        this.raster = 0; this.rowCounter = 0;
        this.lineAddress = this.dispStart;
        this.lineEnable = true;
        this.rowEvents();
        // a frame has restarted: the blink counter moves on (MAME's update_cursor_state, called only at
        // the end of the vertical total adjust)
        this.frameStarts++;
        this.updateCursorState();
      } else this.adjustCounter++;
    }
  }
  // the row just reached: R6 turns the display off and reloads the address, R7 starts VS
  rowEvents() {
    if (this.rowCounter === this.reg[6]) { this.lineEnable = false; this.lineAddress = this.dispStart; }
    if (this.rowCounter === this.reg[7]) { this.vsActive = true; this.vsWidth = 0; }
  }
  // R10's blink bits (mc6845.cpp update_cursor_state): 00 always on, 10 always off, 01 fast blink (every
  // 16 frame boundaries), 11 slow blink (every 32)
  updateCursorState() {
    const last = this.cursorBlinkCount;
    this.cursorBlinkCount = (this.cursorBlinkCount + 1) & 0xFF;
    switch (this.reg[10] & 0x60) {
      case 0x00: this.cursorState = true; break;
      case 0x40: if ((last & 0x10) !== (this.cursorBlinkCount & 0x10)) this.cursorState = !this.cursorState; break;
      case 0x60: if ((last & 0x20) !== (this.cursorBlinkCount & 0x20)) this.cursorState = !this.cursorState; break;
      default: this.cursorState = false; break;
    }
  }

  // ---- outputs ----
  de_r() { return this.de ? 1 : 0; }
  hs_r() { return this.hs ? 1 : 0; }
  vs_r() { return this.vs ? 1 : 0; }
  cursor_r() { return this.cursor ? 1 : 0; }
  get ma_r() { return this.ma; }
  get ra_r() { return this.raster; }
  get cursorX_r() { return this.cursorX; }

  // ---- geometry, in the data sheet's terms ----
  get horizTotal() { return this.reg[0] + 1; }               // characters per line
  get horizDisplayed() { return this.reg[1]; }               // characters displayed
  get vertTotal() { return this.reg[4] + 1; }                // character rows per frame
  get vertDisplayed() { return this.reg[6]; }                // character rows displayed
  get linesPerRow() { return this.reg[9] + 1; }              // raster lines per character row
  get frameLines() { return this.vertTotal * this.linesPerRow + this.reg[5]; } // lines per frame
  get dispStartAddress() { return this.dispStart; }

  // the light pen input latches the address presented when it fires
  assertLightPen() { this.lightPen = this.ma & 0xFFFF; }

  // ---- state ----
  saveState() {
    return {
      reg: [...this.reg], latch: this.latch, hCounter: this.hCounter, rowCounter: this.rowCounter,
      raster: this.raster, adjustCounter: this.adjustCounter, adjustActive: this.adjustActive,
      lineAddress: this.lineAddress, lineEnable: this.lineEnable, ma: this.ma, de: this.de, hs: this.hs,
      vs: this.vs, vsActive: this.vsActive, vsWidth: this.vsWidth, cursorX: this.cursorX,
      cursor: this.cursor, dispStart: this.dispStart, lightPen: this.lightPen, started: this.started,
      frameStarts: this.frameStarts, cursorState: this.cursorState, cursorBlinkCount: this.cursorBlinkCount,
    };
  }
  loadState(s) {
    this.reg.set(s.reg);
    for (const k of ['latch', 'hCounter', 'rowCounter', 'raster', 'adjustCounter', 'adjustActive',
      'lineAddress', 'lineEnable', 'ma', 'de', 'hs', 'vs', 'vsActive', 'vsWidth', 'cursorX',
      'cursor', 'dispStart', 'lightPen', 'started', 'frameStarts', 'cursorState', 'cursorBlinkCount']) this[k] = s[k];
  }
}

// the frame a register set describes, for callers that need it without an instance
MC6845.frameSize = (reg) => ({
  cols: reg[0] + 1, displayedCols: reg[1], rows: reg[4] + 1, displayedRows: reg[6],
  linesPerRow: reg[9] + 1, adjust: reg[5], lines: (reg[4] + 1) * (reg[9] + 1) + reg[5],
});

export { MC6845 };
