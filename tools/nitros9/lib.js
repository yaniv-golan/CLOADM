// Shared by the NitrOS-9 boot tools (boot.js, boot-mame.js, boot-floppy-mame.js) and tests/nitros9.test.js: our boot
// loaders as CoCo 3 ROMs, the DriveWire server that serves an image to either emulator, the records the two runs are
// compared on (DriveWire transactions; the floppy controller's register writes), and the text on our machine's screen. Development only; nothing here is loaded by the page.
const zlib = require('zlib');

// The CoCo 3 internal ROM (32K) with one of our loaders (js/machines/nitros9.js): 'drivewire' (over the Becker
// port, the default) or 'floppy' (the CoCo disk controller's drive 0): the ones the page boots with
const loaderRom = (kind = 'drivewire') => require('../../js/emu.js').nitros9LoaderRom(kind);

// The floppy boot's comparison: every CPU write to the disk controller's registers ($FF40 control latch, $FF48-$FF4B
// WD1773), in order, as "ff4a=01". MAME records them with a Lua write tap (boot-floppy-mame.js), ours by wrapping the
// machine's write (fdcWrites). Only register numbers and values: no disk data is read this way.
const FLOPPY = Object.freeze({ seconds: 50, typed: [{ at: 35, text: '\r' }, { at: 40, text: 'dir\r' }] });
const fdcWrite = (a, v) => `${a.toString(16)}=${v.toString(16).padStart(2, '0')}`;
function fdcWrites(m) {
  const out = [], write = m.write.bind(m);
  m.write = (a, v) => { if (a >= 0xFF40 && a <= 0xFF4F) out.push(fdcWrite(a, v)); return write(a, v); };
  return out;
}
// Our CoCo 3 (512K) with the floppy loader as its ROM and the CoCo disk controller (no ROM of its own) holding
// `bytes` in drive 0, reset
function coco3Floppy(Emu, cpu, bytes) {
  const m = Emu.createMachine('coco3', { cpu, ram: 512 });
  m.setRoms({ basic: loaderRom('floppy') });
  const fdc = new Emu.devices.cocofdc({});
  m.insertCartridge(fdc);
  fdc.mount(0, { bytes: bytes.slice(), format: Emu.detectDiskFormat(bytes, 'n9.dsk'), name: 'n9.dsk' });
  m.reset(true);
  return m;
}

// One DriveWire transaction as the runs are compared on it, or null for one left out. TIME is left out: NitrOS-9
// asks for it from its clock module and from startup's `date`, and how many times depends on how long a run lasts,
// not on what it does. Status polls (SERREAD) are not reported by the server at all.
const record = (what, info) => (what === 'TIME' ? null : `${what} ${JSON.stringify(info || {})}`);

// The server for one image (drive 0), on an in-memory store, its clock fixed; `transactions` collects record()s
// and `counts` every transaction by name.
async function driveWire(Emu, bytes) {
  const { DriveWireServer } = await import('../../js/drivewire/server.js');
  const store = new Emu.MemoryMediaStore({ clock: () => 0 });
  await store.write('disks/nitros9.dsk', bytes);
  const dw = new DriveWireServer({ store, clock: () => new Date(2026, 10, 15, 12, 0, 0) });
  await dw.mount(0, 'disks/nitros9.dsk');
  const transactions = [], counts = {};
  dw.onTransaction = (what, info) => {
    counts[what] = (counts[what] || 0) + 1;
    const r = record(what, info);
    if (r) transactions.push(r);
  };
  return { dw, transactions, counts };
}

// Our CoCo 3 (512K) with the DriveWire loader as its ROM and `dw` on its Becker port, reset
function coco3(Emu, cpu, dw) {
  const m = Emu.createMachine('coco3', { cpu, ram: 512, becker: true });
  m.setRoms({ basic: loaderRom() });
  m.becker.attach(dw);
  m.reset(true);
  return m;
}

// The text in video memory as the GIME's text mode lays it out: from its start address, 32/40/64/80 columns with
// or without attribute bytes (or the VDG-compatible 32x16), 24 rows. Lines-per-row, the horizontal offset and
// vertical scrolling are not applied (NitrOS-9's boot and shell screens use none of them). Trailing blanks and
// blank lines at the end dropped; unprintable bytes as '.'
function screenText(m) {
  const g = m.gime, r = g.regs, base = g.videoBase(), ram = m.mem;
  let cols, attr, rows;
  if (g.legacy) { cols = 32; attr = false; rows = 16; }
  else if (r[8] & 0x80) return ['(graphics mode)'];
  else { const f = r[9]; cols = (f & 0x10) ? ((f & 4) ? 80 : 64) : ((f & 4) ? 40 : 32); attr = !!(f & 1); rows = 24; }
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let s = '';
    for (let x = 0; x < cols; x++) {
      let c = ram[(base + (y * cols + x) * (attr ? 2 : 1)) % ram.length];
      if (g.legacy) { c &= 0x7F; if (c < 0x20) c += 0x40; else if (c >= 0x60) c -= 0x40; }
      c &= 0x7F;
      s += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : '.';
    }
    lines.push(s.replace(/\s+$/, ''));
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines;
}

// RGBA pixels to a PNG file's bytes
function png(w, h, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { loaderRom, record, driveWire, coco3, FLOPPY, fdcWrites, coco3Floppy, screenText, png };
