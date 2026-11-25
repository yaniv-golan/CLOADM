// The clean-room BASIC (docs/clean-room-basic.md) on a Dragon 64, for the tests and for tools/basic-bb: boot a
// machine with a given BASIC ROM in the "basic" socket, type into it through the keyboard matrix, and read the
// screen. Nothing here knows the ROM's internals: it works the same on any Dragon 64 BASIC.
const Emu = require('../load.js')();
const zlib = require('zlib'), crypto = require('crypto');

// a PNG of RGBA pixels (8 bits a channel, filter 0 on every row)
function rgbaPng(w, h, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type, 'ascii'), data]), c = Buffer.alloc(4);
    len.writeUInt32BE(data.length); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// One VDG text cell as text. Normal characters ($40-$7F) as themselves; inverse ones ($00-$3F) as lower case
// for letters and @ [ \ ] ^ _ (the Dragon shows lower case that way), and as the character followed by U+0332
// (a combining low line) otherwise; a semigraphics cell (bit 7: blocks, the cursor) as a space.
function cell(v) {
  if (v & 0x80) return ' ';
  const c = v & 0x3F, ch = String.fromCharCode(c < 32 ? c + 64 : c);
  if (v & 0x40) return ch;
  return c < 32 ? String.fromCharCode(c + 96) : ch + '̲';
}

class Basic {
  // rom: the 16K image for the "basic" socket; opts.machine (default dragon64)
  constructor(rom, { machine = 'dragon64' } = {}) {
    this.m = Emu.createMachine(machine);
    this.m.setRoms({ basic: rom, basic64: null });
    this.m.reset(true);
    this.frames = 0;
  }
  frame() { this.m.runFrame(); this.frames++; }
  // the picture now (the last whole frame): { width, height, sha256 of its RGBA pixels, png (base64) }
  shot(name) {
    const f = this.m.render(), p = Emu.frameToRGBA(f), rgba = Buffer.from(p.buffer, p.byteOffset, p.byteLength);
    return { name, width: f.width, height: f.height, sha256: crypto.createHash('sha256').update(rgba).digest('hex'), png: rgbaPng(f.width, f.height, rgba).toString('base64') };
  }
  // the SHA-256 of the last whole frame's RGBA pixels
  pixHash() {
    const p = Emu.frameToRGBA(this.m.render());
    return crypto.createHash('sha256').update(Buffer.from(p.buffer, p.byteOffset, p.byteLength)).digest('hex');
  }
  // Start recording the transcript: every line that scrolls off the top of the screen, in order. A scroll is
  // recognised by what the CPU does, whatever the ROM: a write to the top row of a byte it has just read from the
  // same column of the row below (a block move). Writes that are not a move and overwrite text in the top row are
  // flagged, so a line is never lost silently. transcript() adds the screen as it is now.
  record() {
    if (this.taps) for (const t of this.taps) t.remove();
    const m = this.m, recent = [];
    this.lines = []; this.flags = [];
    const SCR = 0x400;
    const cells0 = () => Array.from({ length: 32 }, (_, c) => cell(m.ram[SCR + c]));
    const row0 = () => cells0().join('').replace(/\s+$/, '');
    let snap = null, moved = new Set();     // the top row as it was before the move started; the columns moved
    this.taps = [
      m.busTaps.addReadTap({ start: SCR, end: SCR + 0x1FF }, (a) => { recent.push(a); if (recent.length > 8) recent.shift(); }),
      m.busTaps.addWriteTap({ start: SCR, end: SCR + 31 }, (a, v, old) => {
        const c = a - SCR;
        if (recent.includes(a + 32) && v === m.ram[a + 32]) {
          if (!moved.size) { const r = cells0(); r[c] = cell(old); snap = r.join('').replace(/\s+$/, ''); }
          moved.add(c);
          if (moved.size === 32) { this.lines.push(snap); moved = new Set(); }
        } else {
          if (old !== v && old !== 0x60 && !(old & 0x80)) this.flags.push({ frame: this.frames, kind: 'top-row-overwritten', row: row0() });
          moved = new Set();
        }
      }, { old: true }),
    ];
  }
  // the lines recorded since record(), then the screen's rows (trailing blank rows dropped)
  transcript() { return [...this.lines, ...this.screen()]; }
  run(n) { for (let i = 0; i < n; i++) this.frame(); }
  // the 16 rows of the screen as text (trailing spaces kept), read from the display's own page
  rows() {
    const m = this.m, at = m.sam.displayBase, rows = [];
    for (let r = 0; r < 16; r++) {
      let s = '';
      for (let c = 0; c < 32; c++) s += cell(m.displayByte((at + r * 32 + c) & m.sam.counterMask));
      rows.push(s);
    }
    return rows;
  }
  // the rows as text: trailing spaces and trailing blank rows dropped
  screen() {
    const r = this.rows().map((l) => l.replace(/\s+$/, ''));
    while (r.length && !r[r.length - 1]) r.pop();
    return r;
  }
  // type text through the matrix, paced by what the machine reads (the typist's paced mode), and run until it has
  // all been taken or `limit` frames pass. '\n' is ENTER. Returns the typist job's status.
  type(text, limit = 20000) {
    const job = this.m.typist.typePaced(text);
    let n = 0;
    while (job.status === 'typing' && n++ < limit) this.frame();
    return job.status;
  }
  // hold matrix keys down together until the machine has read the last one's column 4 times (and 3 frames), then
  // let go for 3 frames; false if it was never read within `limit` frames
  keys(names, limit = 1500) {
    const m = this.m, last = names[names.length - 1], pos = m.keyPos[last];
    if (!pos || names.some((k) => !m.keyPos[k])) throw new Error(`no key ${names.join('+')}`);
    const base = m.colScans[pos[1]];
    for (const k of names) m.setKey(k, true);
    let n = 0;
    while ((m.colScans[pos[1]] - base < 4 || n < 3) && n < limit) { this.frame(); n++; }
    for (const k of names) m.setKey(k, false);
    this.run(3);
    return n < limit;
  }
  // run until fn() is true for `stable` frames in a row, or `limit` frames pass; true if it held
  until(fn, { limit = 3000, stable = 1 } = {}) {
    let ok = 0;
    for (let n = 0; n < limit; n++) {
      if (fn()) { if (++ok >= stable) return true; } else ok = 0;
      this.frame();
    }
    return false;
  }
  // the OK prompt is on the screen's last line with text, and the screen has not changed for `stable` frames
  waitOk({ limit = 3000, stable = 5 } = {}) {
    let last = null;
    return this.until(() => {
      const s = this.screen(), key = s.join('\n'), same = key === last;
      last = key;
      return same && s.length > 0 && s[s.length - 1] === 'OK';
    }, { limit, stable });
  }
}

// Run one case (docs/clean-room-basic.md section 7) on a fresh machine with `rom` in the BASIC socket.
// Lines are typed through the keyboard; lines starting with # are directives (# alone or "# text": a comment):
//   #type TEXT      type TEXT (\n is ENTER) and wait until the screen settles (for INPUT, INKEY$)
//   #break          press BREAK and wait for OK
//   #keys A+B       hold matrix keys together (SHIFT+LEFT, SHIFT+0, CLEAR) until the machine has read them, then
//                   let go, and wait until the screen settles
//   #frames N       run N frames
//   #wait-text RE   run until the screen matches the regular expression
//   #timeout S      the emulated seconds each wait may take from here on (default 30)
//   #nowait         the next line is not waited for with OK, only until the screen settles
//   #screenshot NAME  record the picture as it is now (for graphics: the result's shots, each with a PNG and the
//                   SHA-256 of its pixels, which tools/basic-bb/compare.js compares)
// A typed line that starts with a digit is a program line: waited for until the screen settles; any other line
// is waited for until OK is back. -> { status, transcript, flags, frames }; status 'ok', 'no-boot', 'timeout' (and
// where), or the typist's status when the machine stopped reading the keyboard.
//
// guard (on by default; tools/basic-bb/run.js and the black-box cases always use it): the case is stopped, with
// status 'refused' and nothing of its screen recorded, if the CPU ever runs an instruction from RAM written since
// the case began: machine code a case put there (through a vector it POKEd, say) could read the ROM. Our own
// suite's EXEC and USR cases (tests/basic/own) run without it.
function runCase(rom, text, { machine = 'dragon64', guard = true } = {}) {
  const b = new Basic(rom, { machine });
  let refused = null;
  const shots = [];
  const out = (status, extra = {}) => (refused
    ? { status: 'refused', why: refused, transcript: [], flags: [], frames: b.frames }
    : { status, transcript: b.lines ? b.transcript() : b.screen(), flags: b.flags || [], frames: b.frames, ...(shots.length ? { shots } : {}), ...extra });
  if (!b.waitOk({ limit: 600, stable: 3 })) return out('no-boot');
  let limit = 30 * 50, nowait = false;
  const settle = () => { let last = null; return b.until(() => { const k = b.rows().join(''); const same = k === last; last = k; return same; }, { limit, stable: 10 }); };
  const typed = (t) => { const st = b.type(t, limit * 4); return st === 'done' ? null : st; };
  let st = typed('CLS\n');
  if (st) return out(st, { at: 'CLS' });
  if (!b.waitOk({ limit })) return out('timeout', { at: 'CLS' });
  b.record();
  if (guard) {
    const written = new Uint8Array(0x8000);
    b.m.busTaps.addWriteTap({ start: 0, end: 0x7FFF }, (a) => { written[a] = 1; });
    b.m.addProbe((pc) => {
      if (pc < 0x8000 && written[pc] && !refused) refused = `ran code at $${pc.toString(16).toUpperCase()} written during the case`;
    });
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (refused) return out('refused');
    const line = lines[i], where = `line ${i + 1}`;
    if (line.startsWith('#')) {
      const m = /^#(\S*)\s?(.*)$/.exec(line), cmd = m[1], arg = m[2];
      if (cmd === '') continue;
      if (cmd === 'type') { if ((st = typed(arg.replace(/\\n/g, '\n')))) return out(st, { at: where }); if (!settle()) return out('timeout', { at: where }); }
      else if (cmd === 'break') {
        const job = b.m.typist.holdPaced('BREAK');
        let n = 0;
        while (job.status === 'typing' && n++ < limit) b.frame();
        if (!b.waitOk({ limit })) return out('timeout', { at: where });
      } else if (cmd === 'keys') { if (!b.keys(arg.split('+'), limit)) return out('not-consumed', { at: where }); if (!settle()) return out('timeout', { at: where }); }
      else if (cmd === 'frames') b.run(Number(arg));
      else if (cmd === 'wait-text') { const re = new RegExp(arg, 'm'); if (!b.until(() => re.test(b.screen().join('\n')), { limit })) return out('timeout', { at: where }); }
      else if (cmd === 'timeout') limit = Math.round(Number(arg) * 50);
      else if (cmd === 'nowait') nowait = true;
      else if (cmd === 'screenshot') { b.frame(); shots.push(b.shot(arg || `shot${shots.length + 1}`)); }
      else return out('bad-directive', { at: where });
      continue;
    }
    if (!line.trim()) continue;
    if ((st = typed(line + '\n'))) return out(st, { at: where });
    const ok = nowait || /^\s*\d/.test(line) ? settle() : b.waitOk({ limit });
    nowait = false;
    if (!ok) return out('timeout', { at: where });
  }
  return out('ok');
}

module.exports = { Basic, cell, runCase, Emu };
