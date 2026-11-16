/*
 * families.d64plus: the Dragon 64 Plus (profile d64plus; MAME 0.264 src/mame/trs/dragon.cpp,
 * d64plus_state). A Dragon 64 - 6809 + SAM + two PIAs + MC6847 + ACIA - with a second, 80-column board
 * driven by a Hitachi HD6845S CRTC (js/chips/mc6845.js) and its own character generator.
 *
 * Two screens:
 *   - the Dragon's own MC6847 picture (inherited from SamMachine), and
 *   - the "plus" screen: 640 x 264 pixels, 80 x 22 characters of 8 x 12, drawn by the CRTC from the video
 *     RAM bank through an 8K character generator. this.view picks which one render() returns; the page's
 *     Display tab switches it.
 *
 * The boards (dragon.cpp, d64plus_state::machine_start):
 *   $FFE0  CRTC status (read; the HD6845S reads 0) / register address (write)
 *   $FFE1  CRTC register data (read: R12-R15 and the light pen; write)
 *   $FFE2  read: display enable, $FF while DE is on and $FE when it is blanking (d64plus_6845_disp_r)
 *          write: the RAM bank register (d64plus_bank_w)
 *
 * RAM (d64plus_bank_w, and the two memory_bank_creators it drives):
 *   bits 1-2 pick the 32K bank the CPU and the VDG see at $0000-$7FFF: 0 = the standard 64K Dynamic RAM,
 *   2 = plus RAM bank A, 6 = plus RAM bank B (any other value leaves the banks as they were and logs an
 *   error in MAME).
 *   bit 0 additionally overlays the 2K video RAM over $0000-$07FF for the CPU and the VDG (bank C).
 *   bit 0 clear does not move the video overlay back: the switch above re-selects entries 0-2 first, so a
 *   write with bit 0 clear always puts the video window back on the selected RAM bank.
 * Each bank access is 32K because the SAM drives A14; the video RAM is 2K and mirrors through the SAM's
 * counter mask as any RAM does.
 *
 * The primary source for the bank register is Compusense's "Dragonplus Interface Technical Information"
 * (4 pages, (c) Compusense Ltd; archived at archive.worldofdragon.org, downloads/Software/Dragon/Compusense
 * Ltd/Dragon Plus/DragonPlusTech.pdf). Page 1: "$FFE0 6845 control register, $FFE1 6845 Data register,
 * $FFE2 MEMORY BANK REGISTER", the two 32K dynamic banks (A, B) and the 2K static video RAM (C) over the low
 * addresses, and "The 2k static RAM, Bank "C" can overlay any other bank ... without losing the remainder of
 * the dynamic bank". Page 2: the write table, R2 R1 = 00 standard, 01 bank A, 11 bank B, R0 = 1 video RAM
 * bank C, "Bits 3-7 must not be used". Page 3: read bit 0 "SO": 1 "Video display busy i.e. not blanking",
 * 0 "Video display available, ie blanking". Page 4: the character set in a 2764, "only the first character
 * set is used", sixteen bytes a character. This implementation follows it; R2 R1 = 10 ($04) is not in the
 * table, and is left as MAME leaves it (no change).
 *
 * config.mameCompat: MAME 0.264 does not apply the bank register to memory. d64plus_bank_w() sets the
 * memory_bank entries, but every CPU and VDG access to $0000-$7FFF still reaches the standard RAM: a Lua probe
 * of 0.264 writing each documented $FFE2 value and then $0100 and $1000 reads back what it wrote through the
 * CPU every time, while the :plus_ram and :video_ram shares are never written (MAME 0.289, with the same
 * driver source, applies the banks). Under mameCompat the register is kept (and saved) but the memory map
 * stays on the standard RAM, so the comparison can run (docs/verification.md, "Deviations from MAME").
 *
 * Timing. The CRTC's character clock is 14.218 MHz / 8 (dragon.cpp: HD6845S(config, m_crtc,
 * 14.218_MHz_XTAL / 4 / 2)), and this machine's tick is one CPU cycle = 14.218 MHz / 16, so a character
 * clock is exactly half a tick: two CRTC characters per tick, 114 per line (R0 = 113), 316 lines a frame
 * (26 rows of 12 plus 4 adjust, R4 = 25, R9 = 11, R5 = 4) = 49.34 Hz, as MAME's plus_screen reports. A
 * line is 57 ticks, the same as the VDG's PAL line, so the machine's line events clock the CRTC. The
 * CRTC is advanced lazily to the tick being read or drawn (crtcSync): the CPU reads $FFE2 at a tick
 * boundary, which is a character boundary, so the value it sees is the DE of the character starting then.
 *
 * The plus picture is drawn at each CRTC frame restart from the registers as they then stand, which is
 * what MAME's mc6845 screen_update does (it draws the whole screen bitmap at the start of the screen's
 * frame, resetting the display address there): a register written mid-frame shows from the next frame.
 *
 * The character generator is MAME's: address (code << 4) | (ra & 0x0F), masked to 4K (crtc_update_row
 * reads m_char_rom->base()[addr & 0xfff]), and the cursor column is forced to $FF.
 *
 * ROMs: the two BASIC banks (d64_1.rom, d64_2.rom) and, as chips the machine reads directly rather than
 * through the CPU bus, the character generator (chargen.ic22, 8K) and the timing PROM (n82s147an.ic12,
 * 512 bytes). MAME needs the PROM's file to start the machine but the driver never reads it; CLOADM
 * stores it if supplied, does not use it, and never needs it to boot. The real glyphs are only exercised
 * with a user-supplied character generator.
 */
import { MC6845 } from '../chips/mc6845.js';
import { SamMachine } from './sam.js';
import { Frame } from '../video/frame.js';

const PLUS_WIDTH = 640, PLUS_HEIGHT = 264;     // R1 = 80 characters x 8, R6 = 22 rows x 12
const VIDEO_RAM = 0x800;
const CRTC_CHARS_PER_TICK = 2;                  // CRTC cclk = 14.218 MHz / 8; a tick is / 16
// the two colours: MAME's PALETTE(config, m_palette, palette_device::MONOCHROME) - pen 0 black, pen 1 white
const MONO = (b) => 0xFF000000 | (b << 16) | (b << 8) | b;   // 0xAABBGGRR, grey level b

class D64PlusMachine extends SamMachine {
  constructor(profile, config) {
    super(profile, config);
    // RAM: the standard 64K is this.ram (Machine's memoryArray), the plus board adds two 32K banks and the
    // 2K video window, all as in MAME (m_plus_ram 0x10000 with entries at 0 and 0x8000, m_video_ram 0x800)
    this.plusRam = new Uint8Array(0x10000);
    this.videoRam = new Uint8Array(VIDEO_RAM);
    this.pramBank = 0;              // 0 standard, 1 bank A, 2 bank B
    this.vramBank = 0;              // 0 standard, 1 bank A, 2 bank B, 3 the video RAM overlay
    this.crtc = new MC6845();
    this.crtcTicks = 0;             // the tick up to which the CRTC has been clocked
    this.crtcFrame = 0;             // the tick of the CRTC frame currently being drawn
    this.plusFrame = new Frame(PLUS_WIDTH, PLUS_HEIGHT, 4 / 3);
    this.plusFrame.table[0] = MONO(0); this.plusFrame.table[1] = MONO(0xFF);
    this.view = 'vdg';              // which screen render() returns: 'vdg' or 'plus'
    // MAME 0.264's bank register never reaches memory (see the header): mameCompat only
    this.banksReachMemory = !config.mameCompat;
    // a chip the machine reads directly: the character generator. Without one the plus screen is blank.
    this.charGen = null;
  }

  romsChanged() {
    super.romsChanged();
    const g = this.roms.chargen;
    this.charGen = g ? g.subarray(0, Math.min(0x2000, g.length)) : null;
    // the timing PROM is stored but never read (MAME loads it and the driver ignores it)
  }

  // ---------------- the RAM banks ----------------
  // The two memory_bank_creators: the 32K bank covers $0000-$7FFF (the SAM drives A14), and the video-RAM
  // bank covers only $0000-$07FF. An address outside a bank's range falls through to the underlying map
  // (MAME installs the banks as handlers, so unmapped addresses keep the map's own handlers - which for
  // $0000-$7FFF is the SAM's RAM space, i.e. entry 0's memory). Only the video bank can leave a hole, and
  // only over $0800-$7FFF, which the 32K bank then serves.
  bankRead(entry, a) {
    switch (entry) {
      case 0: return this.ram[a];
      case 1: return this.plusRam[a];
      case 2: return this.plusRam[0x8000 + a];
      default: return this.videoRam[a & (VIDEO_RAM - 1)];   // entry 3: the video RAM
    }
  }
  bankWrite(entry, a, v) {
    switch (entry) {
      case 0: if (a < 0x10000) this.ram[a] = v; return;
      case 1: this.plusRam[a] = v; return;
      case 2: this.plusRam[0x8000 + a] = v; return;
      default: this.videoRam[a & (VIDEO_RAM - 1)] = v; return;
    }
  }
  // the byte at a (under 32K) as the CPU and the VDG see it: the video bank first (it maps only
  // $0000-$07FF), then the 32K bank
  cpuBankByte(a) {
    if (!this.banksReachMemory) return this.ram[a];
    if (a < VIDEO_RAM) return this.bankRead(this.vramBank, a);
    return this.bankRead(this.pramBank, a);
  }
  cpuBankWrite(a, v) {
    if (!this.banksReachMemory) { this.ram[a] = v; return; }
    if (a < VIDEO_RAM) this.bankWrite(this.vramBank, a, v);
    else this.bankWrite(this.pramBank, a, v);
  }
  // the VDG's fetches go through the same banks (MAME installs them in the SAM's own space 0); its counter can
  // reach the upper 32K, which no bank covers
  displayByte(a) { return a < 0x8000 ? this.cpuBankByte(a) : this.ram[a]; }

  // d64plus_bank_w
  writeBank(v) {
    switch (v & 0x06) {
      case 0: this.pramBank = 0; this.vramBank = 0; break;
      case 2: this.pramBank = 1; this.vramBank = 1; break;
      case 6: this.pramBank = 2; this.vramBank = 2; break;
      default: break;                 // MAME logs an error and leaves the banks alone
    }
    if (v & 0x01) this.vramBank = 3;
  }
  // d64plus_6845_disp_r: $FF while the display is on, $FE while it is blanking
  dispRead() { return this.crtc.de_r() ? 0xFF : 0xFE; }

  // ---------------- memory map ----------------
  // The base map is the Dragon 64's; $0000-$7FFF is the selected RAM bank and $FFE0-$FFE2 is the CRTC.
  // The SAM forms the RAM address first (in 64K map type 0, page bit P1 moves $0000-$7FFF onto the upper 32K:
  // SamMachine.ramAddr, MAME's sam6883_device::read/write), and the banks are installed only over the SAM's
  // $0000-$7FFF (dragon.cpp machine_start), so a P1-paged access reaches the standard RAM's upper half.
  read(a) {
    if (a < 0x8000) { const r = this.ramAddr(a, this.sam.reg); return r < 0x8000 ? this.cpuBankByte(r) : this.ram[r]; }
    if (a >= 0xFFE0 && a <= 0xFFE2) { this.crtcSync(this.ioTime()); return a === 0xFFE0 ? this.crtc.readStatus() : a === 0xFFE1 ? this.crtc.readRegister() : this.dispRead(); }
    return super.read(a);
  }
  write(a, v) {
    if (a < 0x8000) { const r = this.ramAddr(a, this.sam.reg); if (r < 0x8000) this.cpuBankWrite(r, v); else this.ram[r] = v; return; }
    if (a >= 0xFFE0 && a <= 0xFFE2) {
      this.crtcSync(this.ioTime());
      if (a === 0xFFE0) this.crtc.writeAddress(v);
      else if (a === 0xFFE1) this.crtc.writeRegister(v);
      else this.writeBank(v);
      return;
    }
    super.write(a, v);
  }
  // A side-effect-free read of what the CPU would see, for the tools and the debugger's memory view. It follows
  // the SAME map as read(): the SAM's RAM address first, then the plus banks over $0000-$7FFF, then the CRTC at
  // $FFE0-$FFE2 and the base map above. The difference is that nothing here advances the CRTC: crtcSync() is not
  // called (it clocks the chip and can start a frame). Inheriting SamMachine.peek would read the WRONG memory:
  // with a bank selected the CPU's $0100 is a bank byte, not this.ram[0x100].
  //
  // $FFE0 (status) is 0 on the HD6845S and needs no clock; $FFE1 (register data) is answered by the same
  // readRegister() the CPU's read uses - side-effect-free for every register except the light-pen latch R16,
  // which a look must not clear, so R16/R17 read as 0 here; $FFE2 (DE) is 0xFF/0xFE from the clock, which a look
  // does not advance, so it reads the level as of the last clock rather than inventing one.
  peek(a) {
    a &= 0xFFFF;
    if (a < 0x8000) { const r = this.ramAddr(a, this.sam.reg); return r < 0x8000 ? this.cpuBankByte(r) : this.ram[r]; }
    if (a === 0xFFE0) return this.crtc.readStatus();
    if (a === 0xFFE1) { const r = this.crtc.latch; return r === 16 || r === 17 ? 0 : this.crtc.readRegister(); }
    if (a === 0xFFE2) return this.crtc.de ? 0xFF : 0xFE;
    return super.peek(a);
  }

  // A tool's write (Machine.poke) goes where the CPU's write goes: through the SAM's map and, under $8000, the selected
  // RAM bank (write() above), so the byte the CPU reads back is the one written.
  poke(a, v) {
    a &= 0xFFFF;
    if (a < 0x8000) {
      const r = this.ramAddr(a, this.sam.reg);
      if (r < 0x8000) { this.cpuBankWrite(r, v); return true; }
      if (r < this.ramSize) { this.ram[r] = v; return true; }
      return false;
    }
    return super.poke(a, v);        // above $8000 it is the SAM's: ROM and I/O (the CRTC ports too) take nothing
  }
  // the CRTC ports are I/O, not the vector ROM the SAM base class would call them
  writeKind(a) {
    a &= 0xFFFF;
    if (a >= 0xFFE0 && a <= 0xFFE2) return 'io';
    return super.writeKind(a);
  }

  // ---------------- the CRTC clock ----------------
  // Advance the CRTC to tick t: two character clocks per tick. Called before any access whose result
  // depends on CRTC time ($FFE0-$FFE2, and the line events that draw the plus screen).
  crtcSync(t) {
    if (t <= this.crtcTicks) return;
    let n = (t - this.crtcTicks) * CRTC_CHARS_PER_TICK;
    this.crtcTicks = t;
    while (n-- > 0) {
      const before = this.crtc.frameStarts;
      this.crtc.clockChar();
      if (this.crtc.frameStarts !== before) this.drawPlus();   // a frame restarted: MAME draws the screen then
    }
  }

  // ---------------- the plus screen ----------------
  // crtc_update_row for the whole visible picture, from the registers as they stand now. MAME draws the
  // bitmap at the start of the screen's frame with m_current_disp_addr reset to R12/R13 there, so this
  // runs at each CRTC frame restart.
  drawPlus() {
    const c = this.crtc, px = this.plusFrame.data, gen = this.charGen;
    const cols = Math.min(80, c.reg[1]), rows = c.reg[6];   // as many rows as R6 displays; the bitmap's 264 lines bound them
    const perRow = c.reg[9] + 1;
    const start = c.dispStartAddress;
    const cur = ((c.reg[14] & 0x3F) << 8) | c.reg[15];
    const startRas = c.reg[10] & 0x1F, endRas = c.reg[11] & 0x1F;
    px.fill(0);
    if (!gen) return;
    for (let row = 0; row < rows && row * perRow < PLUS_HEIGHT; row++) {
      const ma = (start + row * c.reg[1]) & 0x3FFF;
      // the cursor's column in this row, or -1 (mc6845.cpp check_cursor_visible, HD6845S variant: no
      // cursor when the start raster is past the end raster; the blink state gates it)
      const cursorX = c.cursorState && startRas <= endRas && cur >= ma && cur < ma + c.reg[1] ? cur - ma : -1;
      for (let ra = 0; ra < perRow; ra++) {
        const y = row * perRow + ra;
        if (y >= PLUS_HEIGHT) break;
        for (let col = 0; col < cols; col++) {
          const code = this.videoRam[(ma + col) & (VIDEO_RAM - 1)];
          let data = gen[((code << 4) | (ra & 0x0F)) & 0xFFF];
          if (col === cursorX) data = 0xFF;             // the cursor column is forced to $FF
          const o = y * PLUS_WIDTH + col * 8;
          for (let bit = 0; bit < 8; bit++) px[o + bit] = (data & (0x80 >> bit)) ? 1 : 0;
        }
      }
    }
  }

  // a machine line starts: clock the CRTC to it, and draw the plus picture on its frame boundary
  lineStart(line, at) {
    this.crtcSync(at);
    super.lineStart(line, at);
  }

  // ---------------- the screen ----------------
  // render() returns whichever picture this.view names.
  render() { return this.view === 'plus' ? this.plusFrame : super.render(); }
  // the snapshot's `frame` is always the VDG screen; the plus screen travels in `d64plus.plus`
  snapshotPicture() { return super.render(); }

  resetHardware() {
    super.resetHardware();
    this.pramBank = 0; this.vramBank = 0;
    this.crtc.reset();
    this.crtcTicks = this.cycle;
    this.plusFrame.data.fill(0);
  }

  // ---------------- state ----------------
  saveState() {
    return Object.assign(super.saveState(), {
      d64plus: {
        plusRam: this.plusRam.slice(), videoRam: this.videoRam.slice(),
        pramBank: this.pramBank, vramBank: this.vramBank, view: this.view,
        crtc: this.crtc.saveState(), crtcTicks: this.crtcTicks,
        plus: this.plusFrame.data.slice(),
      },
    });
  }
  loadState(s) {
    super.loadState(s);
    const d = s.d64plus;
    if (!d) throw new Error('snapshot: missing "d64plus"');
    this.plusRam.set(d.plusRam); this.videoRam.set(d.videoRam);
    this.pramBank = d.pramBank; this.vramBank = d.vramBank; this.view = d.view;
    this.crtc.loadState(d.crtc); this.crtcTicks = d.crtcTicks;
    this.plusFrame.data.set(d.plus);
  }
  memoryArray() { return this.ram; }
}

export { D64PlusMachine, PLUS_WIDTH, PLUS_HEIGHT };
