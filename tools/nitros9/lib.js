// Shared by the NitrOS-9 boot tools (boot.js, boot-mame.js) and tests/nitros9.test.js: our boot loader as a CoCo 3
// ROM, the DriveWire server that serves an image to either emulator, the record of its transactions that the two
// runs are compared on, and the text on our machine's screen. Development only; nothing here is loaded by the page.
const path = require('path'), zlib = require('zlib');
const { assembleFile, romImage } = require('../mame-diff/lib/firmware');

// The CoCo 3 internal ROM (32K) with our DriveWire loader (bootdw3.asm, over the Becker port)
const loaderRom = () => romImage(assembleFile(path.join(__dirname, 'bootdw3.asm'), '6809'), 0x8000, 0x8000, 0xFF);

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

module.exports = { loaderRom, record, driveWire, coco3, screenText, png };
