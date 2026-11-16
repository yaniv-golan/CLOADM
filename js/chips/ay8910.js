/*
 * General Instrument AY-3-8910 / AY-3-8912 programmable sound generator, as MAME 0.264 emulates it
 * (src/devices/sound/ay8910.cpp, ay8910.h; the plain AY type: 4-bit volumes, 16-step envelope at half rate,
 * no expanded mode). Used by the Dragon Alpha (AY-3-8912: port A only).
 *
 * Registers (latched address, then data): 0-5 tone periods A/B/C (fine, coarse 4 bits), 6 noise period
 * (5 bits), 7 enable (tone bits 0-2 and noise bits 3-5 active low, port A/B output bits 6/7), 8-10 volumes
 * (bit 4: use the envelope), 11-12 envelope period, 13 envelope shape, 14-15 ports A/B. A register reads
 * back as the full byte written (MAME masks unused bits only on the AY8910 and AY8914, not the AY8912). An
 * address with a non-zero upper nibble deselects the chip: data writes are ignored and reads give $FF.
 * Writing register 14 calls portAWrite(value) when port A is an output (register 7 bit 6); changing that bit
 * calls it with the register (output) or $FF (input), as does the first write to register 7 after reset.
 * Reading register 14 takes portARead().
 *
 * Sound: step() advances the generators by one sample of MAME's stream (clock / 8) and returns the three
 * channel outputs, each from MAME's legacy output table (build_single_table, normalised: -0.125 for silence
 * up to 0.375 at volume 15). Channel output = (tone | tone disabled) & (noise | noise disabled), so a
 * channel with both disabled outputs its volume level (how sampled sound is played).
 */
import { state } from '../util.js';

// ay8910_param: Matthew Westcott's measurements as MAME models them (r_up, r_down, resistors per level)
const PARAM = { rUp: 800000, rDown: 8000000, res: [15950, 15350, 15090, 14760, 14275, 13620, 12890, 11370,
  10600, 8590, 7190, 5985, 4820, 3945, 3017, 2345] };
// build_single_table(rl = 1000, normalize = 1, zero_is_off = 1)
function volumeTable(rl = 1000) {
  const temp = [];
  for (let j = 0; j < 16; j++) {
    let rt = 1 / PARAM.rDown + 1 / rl;
    let rw = 1 / PARAM.res[j];
    rt += 1 / PARAM.res[j];
    if (j !== 0) { rw += 1 / PARAM.rUp; rt += 1 / PARAM.rUp; }
    temp.push(rw / rt);
  }
  const min = Math.min(...temp), max = Math.max(...temp);
  return Float32Array.from(temp, (v) => ((v - min) / (max - min) - 0.25) * 0.5);   // MAME's samples are floats
}
export const AY_VOLUME = volumeTable();

const STATE = ['active', 'latch', 'regs', 'lastEnable', 'tones', 'envs', 'prescaleNoise', 'countNoise', 'rng', 'volEnabled'];

export class AY8910 {
  constructor({ portAWrite = null, portARead = () => 0xff } = {}) {
    this.portAWrite = portAWrite;
    this.portARead = portARead;
    this.regs = new Array(16).fill(0);
    this.tones = [0, 1, 2].map(() => ({ period: 0, volume: 0, count: 0, dutyCycle: 0, output: 0 }));
    this.envs = [0, 1, 2].map(() => ({ period: 0, count: 0, step: 0, volume: 0, hold: 0, alternate: 0, attack: 0, holding: 0 }));
    this.volEnabled = [0, 0, 0];
    this.reset();
  }
  // ay8910_reset_ym
  reset() {
    this.active = false;
    this.latch = 0;
    this.rng = 1;
    for (const t of this.tones) Object.assign(t, { period: 0, volume: 0, count: 0, dutyCycle: 0, output: 0 });
    for (const e of this.envs) Object.assign(e, { period: 0, count: 0, step: 0, volume: 0, hold: 0, alternate: 0, attack: 0, holding: 0 });
    this.countNoise = 0;
    this.prescaleNoise = 0;
    this.lastEnable = -1;
    for (let i = 0; i < 14; i++) this.writeReg(i, 0);
  }

  // ---------------- bus (BDIR/BC1 decoded by the board)
  addressW(v) {
    this.active = (v >> 4) === 0;
    if (this.active) this.latch = v & 0x0f;
  }
  dataW(v) { if (this.active) this.writeReg(this.latch, v & 0xff); }
  dataR() {
    if (!this.active) return 0xff;
    if (this.latch === 14) this.regs[14] = this.portARead() & 0xff;
    return this.regs[this.latch];
  }
  peek(r) { return this.regs[r & 15]; }

  writeReg(r, v) {
    this.regs[r] = v;
    const R = this.regs;
    switch (r) {
      case 0: case 1: this.tones[0].period = R[0] | ((R[1] & 0xf) << 8); break;
      case 2: case 3: this.tones[1].period = R[2] | ((R[3] & 0xf) << 8); break;
      case 4: case 5: this.tones[2].period = R[4] | ((R[5] & 0xf) << 8); break;
      case 8: case 9: case 10: this.tones[r - 8].volume = v; break;
      case 11: case 12: this.envs[0].period = R[11] | (R[12] << 8); break;
      case 7:
        if (this.lastEnable === -1 || ((this.lastEnable ^ v) & 0x40)) { if (this.portAWrite) this.portAWrite(v & 0x40 ? R[14] : 0xff); }
        this.lastEnable = v;
        break;
      case 13: {
        // envelope_t::set_shape with the AY's 4-bit step mask
        const e = this.envs[0];
        e.attack = v & 0x04 ? 0x0f : 0;
        if (!(v & 0x08)) { e.hold = 1; e.alternate = e.attack; } else { e.hold = v & 1; e.alternate = v & 2; }
        e.step = 0x0f; e.holding = 0; e.volume = e.step ^ e.attack;
        break;
      }
      case 14: if ((R[7] & 0x40) && this.portAWrite) this.portAWrite(v); break;
      default: break;    // 6 noise period, 15 port B (no port B on the AY-3-8912)
    }
  }

  // ---------------- sound: one sample of MAME's stream (sound_stream_update)
  step(out) {
    const R = this.regs;
    for (const t of this.tones) {
      const period = Math.max(1, t.period);
      t.count += 1;
      while (t.count >= period) { t.dutyCycle = (t.dutyCycle - 1) & 0x1f; t.output = t.dutyCycle & 1; t.count -= period; }
    }
    if (++this.countNoise >= (R[6] & 0x1f)) {
      this.countNoise = 0;
      this.prescaleNoise ^= 1;
      if (!this.prescaleNoise) this.rng = (this.rng >>> 1) | (((this.rng ^ (this.rng >>> 3)) & 1) << 16);
    }
    const noise = this.rng & 1;
    for (let c = 0; c < 3; c++) this.volEnabled[c] = (this.tones[c].output | ((R[7] >> c) & 1)) & (noise | ((R[7] >> (3 + c)) & 1));
    for (const e of this.envs) {
      if (!e.holding) {
        if (++e.count >= e.period * 2) {
          e.count = 0;
          e.step--;
          if (e.step < 0) {
            if (e.hold) { if (e.alternate) e.attack ^= 0x0f; e.holding = 1; e.step = 0; }
            else { if (e.alternate && (e.step & 0x10)) e.attack ^= 0x0f; e.step &= 0x0f; }
          }
        }
      }
      e.volume = e.step ^ e.attack;
    }
    for (let c = 0; c < 3; c++) {
      const t = this.tones[c];
      const v = t.volume & 0x10 ? this.envs[0].volume : t.volume & 0x0f;
      out[c] = AY_VOLUME[this.volEnabled[c] ? v : 0];
    }
    return out;
  }

  saveState() { return state.save(this, STATE); }
  loadState(s) { state.load(this, s, STATE); }
}
