/*
 * ROM self-test: boots the supplied Dragon BASIC ROM(s) on a hidden machine instance and checks
 * BASIC-level behaviour (keyboard, interrupts, tape, joystick, sound, graphics, 64K mode).
 * Produces a plain-text report that can be shared without sharing the ROM itself.
 */
import { assemble } from './asm/assembler.js';
import { createMachine, profiles } from './machines/profiles.js';
import { Tape } from './media/tape.js';
import { buildCas } from './media/cassette.js';
import { tapeFamily } from './media/detect.js';
import { crc32 } from './util.js';

import { frameToRGBA } from './video/frame.js';

// CRC32s of the known-good ROM dumps (as listed by MAME); used to identify what was tested
const KNOWN = {
  '60A4634C': 'Dragon 64 32K-mode BASIC (d64_1.rom) - known good dump',
  '17893A42': 'Dragon 64 64K-mode BASIC (d64_2.rom) - known good dump',
  'E3879310': 'Dragon 32 BASIC (d32.rom) - known good dump',
};
const identifyRom = (crc) => {
  if (KNOWN[crc]) return KNOWN[crc];
  const P = profiles;
  for (const p of Object.values(P)) for (const sl of p.roms) if (sl.crcs.includes(crc)) return `${p.name} ${sl.label} - known good dump`;
  return 'unrecognised dump';
};

// Test program that copies a marker string into RAM and returns to BASIC. It calls no ROM
// routine, so it works on every machine; the test then checks RAM rather than the screen.
// Assembled with the project's assembler for the machine's CPU. Returns { data, mark }.
function markerProgram(cpu, org, msg) {
  const src = cpu === '6803' ? `
      ORG     ${org}
      LDX     #MSG
LOOP    LDAA    0,X
      STAA    $80,X           ; marker copy at MSG+$80
      BEQ     DONE
      INX
      BRA     LOOP
DONE    RTS
MSG     FCB     "${msg}",0
      END` : `
      ORG     ${org}
      LDX     #MSG
      LDY     #MSG+$80        ; marker copy at MSG+$80
LOOP    LDA     ,X+
      STA     ,Y+
      BNE     LOOP
      RTS
MSG     FCB     "${msg}",0
      END`;
  const r = assemble(src, cpu);
  if (!r.ok) throw new Error('self-test program: ' + r.errors.map((e) => e.message).join('; '));
  return { data: Array.from(r.segments[0].data), mark: r.symbols.get('MSG') + 0x80 };
}

class SelfTest {
  // profileId: machine profile; roms: { slotId: Uint8Array }; config: machine options (resolveConfig)
  constructor(profileId, roms, log, config = {}) {
    this.m = createMachine(profileId, config);
    this.m.setRoms(Object.assign({}, roms));
    // what this model's BASIC supports (profiles may override with `basicFeatures`)
    const p = this.m.profile;
    const ext = p.roms.some((x) => x.id === 'extbas') ? !!this.m.roms.extbas : true;
    this.can = Object.assign({ timer: ext, joystk: true, sound: true, pmode: ext, cload: true, mem: true }, p.basicFeatures || {});
    this.log = log || (() => {});
    this.results = [];
    this.frames = 0;
  }

  screenLines() {
    const m = this.m, base = m.profile.textScreen || 0x0400, lines = [];
    for (let r = 0; r < 16; r++) {
      let l = '';
      for (let c = 0; c < 32; c++) {
        const v = m.ram[base + r * 32 + c];
        if (v & 0x80) { l += '#'; continue; }
        const ch = v & 0x3F;
        l += String.fromCharCode(ch < 0x20 ? ch + 0x40 : ch);
      }
      lines.push(l.replace(/\s+$/, ''));
    }
    return lines;
  }
  screen() { return this.screenLines().join('\n'); }
  flat() { return this.screenLines().join(' ').replace(/ +/g, ' '); }

  async run(n) {
    for (let i = 0; i < n; i++) {
      while (!this.m.runFrame()) await this.m.stall;
      this.frames++;
      if ((this.frames & 63) === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }
  async until(pred, max) {
    for (let i = 0; i < max; i++) {
      if (pred()) return true;
      await this.run(1);
    }
    return pred();
  }
  async type(text, settle = 25) {
    this.m.typist.type(text);
    await this.until(() => !this.m.typist.busy, text.length * 8 + 200);
    await this.run(settle);
  }
  // last non-empty lines on screen
  tail(n) { return this.screenLines().filter((l) => l.trim()).slice(-n); }
  // the line printed right after the line that ends with `cmd`
  outputAfter(cmd) {
    const lines = this.screenLines();
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].endsWith(cmd)) return (lines[i + 1] || '').trim();
    return null;
  }
  // Locate the picture (pixels differing from the border colour at the frame's corner) and check
  // that the colour along its diagonal differs from the picture's background (a drawn line).
  diagonalCheck() {
    const m = this.m, px = frameToRGBA(m.render()), w = m.screenWidth, h = m.screenHeight;
    const border = px[0];
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (px[y * w + x] !== border) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return { ok: false, detail: 'blank picture' };
    const counts = new Map();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) counts.set(px[y * w + x], (counts.get(px[y * w + x]) || 0) + 1);
    const bg = [...counts].sort((a, b) => b[1] - a[1])[0][0];
    let hits = 0;
    const N = 16;
    for (let i = 1; i < N; i++) {
      const x = Math.round(x0 + (x1 - x0) * i / N), y = Math.round(y0 + (y1 - y0) * i / N);
      let hit = false;
      for (let dy = -2; dy <= 2 && !hit; dy++) for (let dx = -2; dx <= 2 && !hit; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && px[yy * w + xx] !== bg) hit = true;
      }
      if (hit) hits++;
    }
    const bgShare = counts.get(bg) / ((x1 - x0 + 1) * (y1 - y0 + 1));
    return { ok: hits >= N - 2 && bgShare > 0.9, detail: `picture ${x1 - x0 + 1}x${y1 - y0 + 1}, background ${(bgShare * 100).toFixed(0)}%, line found at ${hits}/${N - 1} diagonal points` };
  }

  async clearScreen() { await this.type('CLS\r', 10); }

  record(name, pass, detail, opts = {}) {
    const r = { name, pass, detail, info: !!opts.info, screen: pass ? null : this.screen() };
    this.results.push(r);
    this.log(`${pass ? 'PASS' : opts.info ? 'INFO' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  }

  async test(name, fn, opts) {
    try { await fn(); } catch (e) { this.record(name, false, 'exception: ' + e.message, opts); }
  }

  async runAll() {
    const m = this.m;
    m.reset(true);

    await this.test('Boot to OK prompt', async () => {
      const ok = await this.until(() => this.screenLines().some((l) => l.trim() === 'OK'), 600);
      this.record('Boot to OK prompt', ok, ok ? `after ${this.frames} frames; banner: "${this.screenLines().filter((l) => l.trim())[0] || ''}"` : 'no OK prompt within 600 frames');
    });
    if (!this.results[0].pass) return this.results;

    await this.test('Arithmetic', async () => {
      await this.clearScreen();
      await this.type('PRINT 123*456\r');
      const out = this.outputAfter('PRINT 123*456');
      this.record('Arithmetic', out === '56088', `PRINT 123*456 -> "${out}"`);
    });

    await this.test('Keyboard symbols', async () => {
      await this.clearScreen();
      const sym = "!#$%&'()*+,-./:;<=>?@";
      await this.type(`PRINT "${sym}"\r`);
      const out = this.outputAfter(`PRINT "${sym}"`);
      this.record('Keyboard symbols', out === sym, `typed PRINT "${sym}" -> "${out}"`);
    });

    if (this.can.timer) await this.test('Field-sync interrupt (TIMER)', async () => {
      await this.clearScreen();
      await this.type('TIMER=0\r', 0);
      const f0 = this.frames;
      await this.run(150);
      await this.type('PRINT TIMER\r', 0);
      const expected = this.frames - f0;
      await this.run(20);
      const v = parseInt(this.outputAfter('PRINT TIMER'), 10);
      this.record('Field-sync interrupt (TIMER)', Math.abs(v - expected) <= 12, `TIMER counted ${v}, ${expected} frames elapsed`);
    });

    if (this.can.cload) await this.test('CLOADM + EXEC from tape', async () => {
      await this.clearScreen();
      const org = m.config.cpu === '6803' ? 0x4800 : 0x4000;
      const prog = markerProgram(m.config.cpu, org, 'TAPE ML OK');
      const tape = new Tape(buildCas([{ name: 'MLTEST', type: 'binary', load: org, exec: org, data: prog.data }], { family: tapeFamily(m.profile) }), m.tickHz, 'mltest', m.profile.tape);
      m.deck.insert(tape);
      await this.type('CLOADM:EXEC\r', 0);
      const marked = () => String.fromCharCode(...Array.from({ length: 10 }, (_, i) => m.ram[prog.mark + i])) === 'TAPE ML OK';
      const ok = await this.until(marked, 4000);
      this.record('CLOADM + EXEC from tape', ok, ok ? `loaded and ran by frame ${this.frames}` : `tape at ${(tape.progress() * 100).toFixed(0)}%, motor ${m.deck.motor ? 'on' : 'off'}`);
    });

    if (this.can.cload) await this.test('CLOAD ASCII BASIC from tape', async () => {
      await this.clearScreen();
      const prog = [...'10 PRINT "TAPE BASIC OK"\r'].map((c) => c.charCodeAt(0));
      const tape = new Tape(buildCas([{ name: 'BASTEST', type: 'basic', ascii: true, data: prog }], { family: tapeFamily(m.profile) }), m.tickHz, 'bastest', m.profile.tape);
      m.deck.insert(tape);
      await this.type('CLOAD\r', 0);
      let sawMotor = false;
      await this.until(() => { if (m.deck.motor) sawMotor = true; return sawMotor && !m.deck.motor; }, 4000);
      await this.run(50);
      await this.type('RUN\r');
      const ok = this.flat().includes('TAPE BASIC OK');
      this.record('CLOAD ASCII BASIC from tape', ok, ok ? '' : 'program did not load/run', { info: !ok });
    });

    if (this.can.joystk) await this.test('Joystick (JOYSTK)', async () => {
      const vals = [];
      for (const want of [8, 55]) {
        await this.clearScreen();
        m.joy[0][0] = want;
        await this.type('PRINT JOYSTK(0)\r');
        vals.push([want, parseInt(this.outputAfter('PRINT JOYSTK(0)'), 10)]);
      }
      m.joy[0][0] = 32;
      const ok = vals.every(([w, g]) => Math.abs(w - g) <= 2);
      this.record('Joystick (JOYSTK)', ok, vals.map(([w, g]) => `set ${w} read ${g}`).join(', '));
    });

    if (this.can.sound) await this.test('Sound (SOUND)', async () => {
      await this.clearScreen();
      m.typist.type('SOUND 100,10\r');
      let changes = 0;
      for (let i = 0; i < 120; i++) { await this.run(1); changes += m.audioEvents.length / 2 - 1; }
      this.record('Sound (SOUND)', changes > 200, `${changes} DAC level changes`);
    });

    if (this.can.pmode) await this.test('Graphics (PMODE 4 LINE)', async () => {
      await this.type('NEW\r');
      await this.type('10 PMODE4,1:PCLS:SCREEN1,1:LINE(0,0)-(255,191),PSET\r20 GOTO 20\rRUN\r');
      await this.run(100);
      // machine-independent check on the rendered frame: the picture (everything that isn't the
      // border colour) must show the drawn line along its diagonal
      const d = this.diagonalCheck();
      this.record('Graphics (PMODE 4 LINE)', d.ok, d.detail);
      m.setKey('BREAK', true); await this.run(5); m.setKey('BREAK', false); await this.run(30);
      const back = this.flat().includes('BREAK') && !this.diagonalCheck().ok;
      this.record('BREAK returns to text mode', back, back ? '' : 'screen not back in text mode with BREAK message');
    });

    await this.test('PRINT MEM', async () => {
      await this.type('NEW\r');
      await this.clearScreen();
      await this.type('PRINT MEM\r');
      const v = parseInt(this.outputAfter('PRINT MEM'), 10);
      this.record('PRINT MEM', v > 10000, `free memory ${v}`, { info: !(v > 10000) });
    });

    if (m.profile.bankSelect && m.roms.basic64) {
      await this.test('Dragon 64: switch to 64K mode (EXEC)', async () => {
        await this.clearScreen();
        await this.type('EXEC\r', 0);
        await this.until(() => m.sam.mapType === 1, 600);
        const ok = await this.until(() => m.sam.mapType === 1 && this.screenLines().some((l) => l.trim() === 'OK'), 600);
        this.record('Dragon 64: switch to 64K mode (EXEC)', ok,
          `SAM map type ${m.sam.mapType}, ROM bank ${(m.pia1.b.outValue() & 4) ? '32K' : '64K'}`);
        if (ok) {
          await this.clearScreen();
          await this.type('PRINT 2^10\r');
          const out = this.outputAfter('PRINT 2^10');
          this.record('Dragon 64: BASIC works in 64K mode', out === '1024', `PRINT 2^10 -> "${out}"`);
        }
      });
    }
    return this.results;
  }

  report() {
    const m = this.m;
    const lines = [];
    lines.push(`ROM self-test: ${m.profile.name} (${m.id})`);
    lines.push(`date: ${new Date().toISOString()}`);
    lines.push(`browser: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'node'}`);
    for (const sl of m.profile.roms) {
      const d = m.roms[sl.id];
      if (!d) { lines.push(`${sl.label}: not loaded`); continue; }
      const c = crc32(d);
      lines.push(`${sl.label}: ${d.length} bytes, CRC32 ${c} (${sl.crcs.includes(c) ? 'known good dump' : identifyRom(c)})`);
    }
    const pass = this.results.filter((r) => r.pass).length;
    lines.push(`result: ${pass}/${this.results.length} passed`);
    lines.push('');
    for (const r of this.results) {
      lines.push(`${r.pass ? 'PASS' : r.info ? 'INFO' : 'FAIL'}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
      if (r.screen) lines.push(r.screen.split('\n').map((l) => '      |' + l).join('\n'));
    }
    return lines.join('\n');
  }
}

export { SelfTest, markerProgram, identifyRom };
