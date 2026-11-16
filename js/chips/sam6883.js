/*
 * MC6883 / SN74LS783 Synchronous Address Multiplexer (SAM).
 * Holds the 16 control bits written through $FFC0-$FFDF (even address clears, odd address sets)
 * and decodes them. Address decoding policy (what lives where) belongs to the machine.
 *
 * The display address counter is modelled as the chip's chain of flip-flops, not as a
 * (base address, row) pair: bits B0-B3 count the byte within a fetched group, bit 4 is the
 * 16-byte offset within a row, and bits 5 and up are the row. The VDG bumps B0-B3 as it asks for
 * each display byte; a carry out of bit 3 toggles bit 4 every XDIV carries for the current mode,
 * and a carry out of bit 4 advances the row after YDIV carries. Horizontal sync clears B1-B3 (odd
 * V modes) or B1-B4 (even V modes), propagating a carry if the cleared bits held one.
 *
 * This is what MAME's sam6883_device does (src/devices/machine/6883sam.h, 0.289), and it is the
 * reason a mid-frame V change cannot be modelled as "switch to a new bytes-per-row": the counter
 * keeps its carry state and its position across the switch. The static result is the familiar
 * bytes-per-line / lines-per-row table, which is why the two models agree on steady pictures.
 */

// bytes fetched per scanline, and the carry divisions, per V mode (0-7)
const BPL = [32, 16, 32, 16, 32, 16, 32, 32];
const XDIV = [1, 3, 1, 2, 1, 1, 1, 1];    // carries out of bit 3 needed to toggle bit 4
const YDIV = [12, 1, 3, 1, 2, 1, 1, 1];   // carries out of bit 4 needed to advance the row

class SAM6883 {
  constructor() { this.reg = 0; this.counter = 0; this.xdiv = 0; this.ydiv = 0; }
  reset() { this.reg = 0; this.counter = 0; this.xdiv = 0; this.ydiv = 0; }
  saveState() { return { reg: this.reg, counter: this.counter, xdiv: this.xdiv, ydiv: this.ydiv }; }
  loadState(s) { this.reg = s.reg; this.counter = s.counter; this.xdiv = s.xdiv; this.ydiv = s.ydiv; }

  // The VDG's field sync reloads the counter from the display offset (the F bits).
  resetVideoCounter() { this.counter = this.displayBase; this.xdiv = 0; this.ydiv = 0; }

  // The VDG asks for the display byte at `offset` within the scanline. Its address line A0 is
  // compared with the counter's bit 0: when they differ, the VDG has advanced a byte and the
  // counter's low bits are bumped, with the carry reaching bit 4 and then the row.
  //
  // `read(addr)` reads one byte of the memory the SAM is driving. It may be a function or an array (an
  // array reads itself): the address may be banked (the Dragon 64 Plus switches the low 32K, and the VDG
  // sees the bank, as MAME's sam6883 reads its own address space).
  //
  // The M1/M0 bits in the SAM control register declare the RAM the SAM is driving (MC6883 data sheet,
  // p. 4-645, "Memory Size": "Two bits (M1 and MO) determine RAM memory size ... One or two banks of
  // 4K x 1 dynamic RAMs / One or two banks of 16K x 1 dynamic RAMs / One bank of 64K x 1 dynamic RAMs /
  // Up to 64K static RAM"). The display address is masked to that size, so a 4K machine mirrors its video
  // RAM every 4K and a 16K one every 16K. MAME agrees on both halves: `m_counter_mask` in 6883sam.cpp
  // (4K -> $0FFF, 16K -> $3FFF, 64K -> $FFFF) masks the display read, and coco12_m.cpp's configure_sam()
  // installs the fitted RAM then turns the space above it into `nop_readwrite`, so absent RAM reads 0 and
  // writes are lost - the CPU side this machine models in js/machines/sam.js's read()/write().
  get counterMask() { return [0x0FFF, 0x3FFF, 0xFFFF, 0xFFFF][this.memSize]; }
  displayRead(read, offset) {
    if ((offset & 1) !== (this.counter & 1)) {
      const carry = (this.counter & 0x000F) === 0x000F;
      this.counter = (this.counter & ~0x000F) | ((this.counter + 1) & 0x000F);
      if (carry) this.carryBit3();
    }
    return read(this.counter & this.counterMask);
  }
  carryBit3() {
    if (++this.xdiv >= XDIV[this.vmode]) {
      this.xdiv = 0;
      this.counter = (this.counter ^ 0x0010) & 0xFFFF;
      if ((this.counter & 0x0010) === 0) this.carryBit4();
    }
  }
  carryBit4() {
    if (++this.ydiv >= YDIV[this.vmode]) { this.ydiv = 0; this.counter = (this.counter + 0x20) & 0xFFFF; }
  }
  // Horizontal sync: clear the low bits, carrying if they held a carry out (the chip's counter is
  // a flip-flop chain, so clearing can itself produce a carry - this is load-bearing for
  // mid-field mode changes and for some semigraphics modes).
  horizontalSync() {
    if (this.vmode === 7) return;                 // V7 is DMA mode: horizontal sync does nothing
    if (this.vmode & 1) {
      const carry = (this.counter & 0x0008) !== 0;
      this.counter &= ~0x000F;
      if (carry) this.carryBit3();
    } else {
      const carry = (this.counter & 0x0010) !== 0;
      this.counter &= ~0x001F;
      if (carry) this.carryBit4();
    }
  }

  // Display data of a line is fetched through the counter (displayRead, by the machine).
  //
  // The VDG walks its 32 byte positions along the line and reads video memory at every
  // `32 / bytes-per-line`-th one (MAME's mc6847.cpp record_scanline_res<>: `pos % sample_modulo`
  // with `sample_modulo = 32 / sample_count`). The address it passes is a monotonic counter
  // (`input(m_video_address++)`), so the offsets are 0, 1, 2... - one per byte actually fetched -
  // not the sampled positions themselves.
  // bytes fetched for the current mode (for tests and callers that need the width)
  get bytesPerLine() { return BPL[this.vmode]; }

  // offset 0..31 within $FFC0-$FFDF
  write(offset) {
    const bit = offset >> 1;
    if (offset & 1) this.reg |= 1 << bit; else this.reg &= ~(1 << bit);
  }

  get vmode() { return this.reg & 7; }                            // V2..V0
  get displayBase() { return ((this.reg >> 3) & 0x7F) << 9; }     // F6..F0 * 512
  get page1() { return (this.reg >> 10) & 1; }                    // P1
  get rate() { return (this.reg >> 11) & 3; }                     // R1..R0 (CPU rate)
  get memSize() { return (this.reg >> 13) & 3; }                  // M1..M0
  get mapType() { return (this.reg >> 15) & 1; }                  // TY: 1 = all RAM
}

export { SAM6883 };
