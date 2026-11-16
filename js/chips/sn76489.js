/*
 * Texas Instruments SN76489A programmable sound generator, as MAME 0.264 emulates it
 * (src/devices/sound/sn76496.cpp, sn76489a_device: 15-bit noise register with feedback mask 0x10000, white-noise
 * taps 0x04 and 0x08, output not inverted, clock divided by 8, not NCR style; MAME constructs it "Sega style", so a
 * tone period of 0 counts as $400 and the register latch starts at register 3).
 *
 * The chip produces one sample per two input clocks (MAME's stream rate is clock / 2) and steps its counters
 * every 8 of those samples. Each sample is the sum of the four channels' volumes where their outputs are high,
 * 0 .. 4 x 8191 (MAX_OUTPUT / 4 per channel, 2 dB per volume step, step 15 silent); MAME's stream value is
 * sample / 32768.
 *
 * There is no reset: the registers keep their values across a machine reset, as in MAME (device_start only).
 *   write(data)       a byte written to the chip (latch / data), applied to the samples after it
 *   sample()          the next sample (advances the chip by one sample)
 *   saveState() / loadState(s)
 */
const MAX_OUTPUT = 0x7fff;
const FEEDBACK = 0x10000, TAP1 = 0x04, TAP2 = 0x08, DIVIDER = 8;

// 2 dB per step from MAX_OUTPUT / 4, truncated to integers (m_vol_table is int32_t); step 15 is silence
const VOL_TABLE = (() => {
  const t = new Int32Array(16);
  let out = MAX_OUTPUT / 4;
  for (let i = 0; i < 15; i++) { t[i] = Math.trunc(Math.min(out, MAX_OUTPUT / 4)); out /= 1.258925412; }
  t[15] = 0;
  return t;
})();

class SN76489 {
  constructor() {
    this.register = new Int32Array(8);   // volumes 0 = loudest at power-on, as MAME
    this.lastRegister = 3;               // Sega-style chips start with the tone 1 volume latched
    this.volume = new Int32Array(4);
    this.period = new Int32Array(4);
    this.count = new Int32Array(4);
    this.output = new Int32Array(4);
    this.rng = FEEDBACK;
    this.output[3] = this.rng & 1;
    this.currentClock = DIVIDER - 1;
  }
  get inNoiseMode() { return (this.register[6] & 4) !== 0; }

  write(data) {
    let r;
    if (data & 0x80) {
      r = (data & 0x70) >> 4;
      this.lastRegister = r;
      this.register[r] = (this.register[r] & 0x3f0) | (data & 0x0f);
    } else r = this.lastRegister;
    const c = r >> 1;
    switch (r) {
      case 0: case 2: case 4:
        if ((data & 0x80) === 0) this.register[r] = (this.register[r] & 0x0f) | ((data & 0x3f) << 4);
        this.period[c] = this.register[r] !== 0 ? this.register[r] : 0x400;
        if (r === 4 && (this.register[6] & 0x03) === 0x03) this.period[3] = this.period[2] << 1;
        break;
      case 1: case 3: case 5: case 7:
        this.volume[c] = VOL_TABLE[data & 0x0f];
        if ((data & 0x80) === 0) this.register[r] = (this.register[r] & 0x3f0) | (data & 0x0f);
        break;
      case 6: {
        if ((data & 0x80) === 0) this.register[r] = (this.register[r] & 0x3f0) | (data & 0x0f);
        const n = this.register[6];
        this.period[3] = (n & 3) === 3 ? this.period[2] << 1 : 1 << (5 + (n & 3));
        this.rng = FEEDBACK;
        break;
      }
    }
  }

  sample() {
    if (this.currentClock > 0) this.currentClock--;
    else {
      this.currentClock = DIVIDER - 1;
      for (let i = 0; i < 3; i++) {
        if (--this.count[i] <= 0) { this.output[i] ^= 1; this.count[i] = this.period[i]; }
      }
      if (--this.count[3] <= 0) {
        // white noise: taps 1 and 2 XORed; periodic noise: tap 2 held at 0
        if (((this.rng & TAP1) !== 0) !== (((this.rng & TAP2) !== 0) && this.inNoiseMode)) this.rng = (this.rng >>> 1) | FEEDBACK;
        else this.rng >>>= 1;
        this.output[3] = this.rng & 1;
        this.count[3] = this.period[3];
      }
    }
    return (this.output[0] ? this.volume[0] : 0) + (this.output[1] ? this.volume[1] : 0)
      + (this.output[2] ? this.volume[2] : 0) + (this.output[3] ? this.volume[3] : 0);
  }

  saveState() {
    return {
      register: Array.from(this.register), lastRegister: this.lastRegister, volume: Array.from(this.volume),
      period: Array.from(this.period), count: Array.from(this.count), output: Array.from(this.output),
      rng: this.rng, currentClock: this.currentClock,
    };
  }
  loadState(s) {
    this.register.set(s.register); this.lastRegister = s.lastRegister; this.volume.set(s.volume);
    this.period.set(s.period); this.count.set(s.count); this.output.set(s.output);
    this.rng = s.rng; this.currentClock = s.currentClock;
  }
}

export { SN76489, VOL_TABLE };
