// Cartridges (js/machines/carts.js, js/chips/sn76489.js): the banked ROM cartridge, the Games
// Master Cartridge and its SN76489A, the Orchestra-90 and the Multi-Pak; the board choice for a cartridge image;
// the Session's cartridge board and Multi-Pak; the slot lines (CART tied to Q). Expected values come from the
// cartridges' MAME 0.264 sources and the chip's behaviour as stated there, worked out here by hand rather than by
// running the code under test. The MAME comparisons themselves are tools/mame-diff/run.js coco --cart <setup>.
const Emu = require('./load')();
const spec = require('../tools/mame-diff/cart/spec.js');
const audio = require('../tools/mame-diff/cart/audio.js');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const throws = (name, fn, re) => { let msg = null; try { fn(); } catch (e) { msg = e.message; } check(name, msg !== null && re.test(msg), msg === null ? 'did not throw' : msg); };

const coco = (config = {}) => { const m = Emu.createMachine('coco', Object.assign({ mameCompat: true }, config)); m.reset(true); return m; };
// a 16K bank whose every byte names the bank and its position
const bank = (k) => new Uint8Array(0x4000).map((_, i) => (k * 16 + (i & 15)) & 0xFF);
const image = (banks) => { const b = new Uint8Array(banks * 0x4000); for (let k = 0; k < banks; k++) b.set(bank(k), k * 0x4000); return b; };

// ---------------------------------------------------------------- SN76489A
{
  // volume: 2 dB per step from a quarter of 32767, truncated; step 15 silent
  const want = []; let v = 32767 / 4;
  for (let i = 0; i < 15; i++) { want.push(Math.floor(v)); v /= Math.pow(10, 2 / 20); }
  want.push(0);
  const p = new Emu.SN76489();
  const levels = want.map((_, i) => { const q = new Emu.SN76489(); q.write(0x80 | 0x05); q.write(0x00); q.write(0x90 | i); let max = 0; for (let k = 0; k < 2000; k++) max = Math.max(max, q.sample()); return max; });
  check('PSG: each volume step gives its level on a sounding channel', levels.every((l, i) => l === want[i]), levels.join(','));
  // tone: period N toggles the output every N chip steps, a step being 8 samples
  p.write(0x80 | 0x0A); p.write(0x00); p.write(0x90);       // tone 0: period 10, loudest
  const edges = []; let prev = p.sample();
  for (let k = 1; k < 2000; k++) { const s = p.sample(); if (s !== prev) edges.push(k); prev = s; }
  const gaps = edges.slice(1).map((e, i) => e - edges[i]);
  check('PSG: period 10 -> a half-period of 80 samples', gaps.length > 10 && gaps.every((g) => g === 80), gaps.slice(0, 6).join(','));
  // period 0 counts as $400 (MAME builds the SN76489A Sega-style)
  const z = new Emu.SN76489(); z.write(0x80); z.write(0x00); z.write(0x90);
  const ze = []; let zp = z.sample();
  for (let k = 1; k < 0x400 * 8 * 4; k++) { const s = z.sample(); if (s !== zp) ze.push(k); zp = s; }
  check('PSG: period 0 counts as $400 (8192-sample half-periods)', ze.length >= 2 && ze[ze.length - 1] - ze[ze.length - 2] === 0x400 * 8, ze.slice(-2).join(','));
  // a data byte with no latch yet goes to register 3, tone 1's volume (Sega-style start)
  const d = new Emu.SN76489(); d.write(0x05);
  check('PSG: the first data byte goes to tone 1 volume (register 3 latched at power-on)', d.volume[1] === want[5], String(d.volume[1]));
  // a data byte without bit 7 goes to the last register latched: here tone 2's frequency, high bits
  const h = new Emu.SN76489(); h.write(0xC3); h.write(0x15);
  check('PSG: latch + data byte: register = low nibble | data << 4', h.register[4] === (0x3 | (0x15 << 4)) && h.period[2] === 0x153, h.register[4].toString(16));
  // periodic noise from the 15-bit register: high one shift (32 steps x 8 samples) in 15
  const n = new Emu.SN76489(); n.write(0xE0); n.write(0xF0);
  const rises = []; let np = n.sample();
  for (let k = 1; k < 3840 * 12; k++) { const v = n.sample(); if (v && !np) rises.push(k); np = v; }
  const spans = rises.slice(1).map((r, i) => r - rises[i]);
  check('PSG: periodic noise is high one shift in 15 (15-bit register)', spans.length > 5 && spans.every((x) => x === 15 * 256), spans.slice(0, 4).join(','));
  // white noise: both levels occur, and writing the noise register restarts the register
  const w = new Emu.SN76489(); w.write(0xE4); w.write(0xF0);
  const seq = (q) => { const a = []; for (let k = 0; k < 8 * 32 * 64; k += 1) { const s = q.sample(); if (k % 256 === 255) a.push(s ? 1 : 0); } return a.join(''); };
  const s1 = seq(w); w.write(0xE4); const s2 = seq(w);
  check('PSG: white noise has both levels and restarts on a noise register write', /0/.test(s1) && /1/.test(s1) && s1 === s2);
  const st = new Emu.SN76489(); st.write(0x83); st.write(0x92); for (let k = 0; k < 777; k++) st.sample();
  const copy = new Emu.SN76489(); copy.loadState(JSON.parse(JSON.stringify(st.saveState())));
  let same = true; for (let k = 0; k < 5000; k++) if (st.sample() !== copy.sample()) same = false;
  check('PSG: saveState / loadState continue identically', same);
}

// ---------------------------------------------------------------- banked ROM cartridge
{
  const m = coco();
  const c = new Emu.devices.banked(image(8));
  let changed = 0; const orig = m.cartridgeChanged.bind(m); m.cartridgeChanged = () => { changed++; orig(); };
  m.insertCartridge(c); m.reset(false);
  let ok = true;
  for (let v = 0; v < 256; v++) { m.write(0xFF40, v); const k = v & 7; if (m.read(0xC000) !== (k * 16) || m.read(0xFEFF) !== ((k * 16 + 15) & 0xFF)) ok = false; }
  check('banked: every $FF40 value shows bank (value x $4000) mod $20000', ok);
  check('banked: a bank switch remaps the machine', changed > 200, String(changed));
  m.write(0xFF40, 5); m.write(0xFF41, 1); m.write(0xFF5F, 2);
  check('banked: other SCS addresses do nothing and read 00', m.read(0xC000) === 5 * 16 && m.read(0xFF41) === 0 && m.read(0xFF40) === 0);
  m.reset(false);
  check('banked: reset selects bank 0', m.read(0xC000) === 0);
  // a 40K image fills the 128K region by repeating: 40K, 40K, 40K, then its first 8K
  const s = new Emu.devices.banked(image(8).subarray(0, 0xA000));
  m.insertCartridge(s); m.reset(false);
  const firsts = []; for (let v = 0; v < 8; v++) { m.write(0xFF40, v); firsts.push(m.read(0xC000), m.read(0xE000)); }
  // bank k byte 0 of the region: image offset (k x 16K) mod 40K; the image's 16K banks are 0,1 and half of 2
  const want = []; for (let k = 0; k < 8; k++) for (const off of [0, 0x2000]) { const r = k * 0x4000 + off, i = r < 0x1E000 ? r % 0xA000 : r - 0x1E000; want.push(((i >> 14) * 16 + (i & 15)) & 0xFF); }
  check('banked: a short image repeats to fill the 128K region (MAME call_load)', firsts.join() === want.join(), `${firsts.join()} / ${want.join()}`);
}
// the CoCo 3: $FF40-$FF5F reach the cartridge only while the GIME's INIT0 ($FF90) bit 2 enables the spare chip select
// (MAME gime.h spare_chip_select_enabled, coco3_state::ff40_read/ff40_write; $00 read otherwise)
{
  const m = Emu.createMachine('coco3', { mameCompat: true });
  m.reset(true);
  m.insertCartridge(new Emu.devices.gmc(image(8))); m.reset(false);
  m.write(0xFF90, 0x00);
  m.write(0xFF40, 3);
  check('CoCo 3: SCS off, a $FF40 write does not reach the cartridge', m.read(0xC000) === 0);
  m.write(0xFF90, 0x04);
  m.write(0xFF40, 3);
  check('CoCo 3: SCS on, $FF40 selects the bank', m.read(0xC000) === 3 * 16 && m.read(0xE000) === 3 * 16);
  m.write(0xFF90, 0x00);
  m.write(0xFF40, 1);
  check('CoCo 3: SCS off again, the bank stays', m.read(0xC000) === 3 * 16);
  // the Games Master's PSG is on SCS too: a write while SCS is off is lost (register 1, tone 0's attenuation, is 0
  // at power-on; $9F sets it to 15)
  m.write(0xFF41, 0x9F);
  check('CoCo 3: SCS off, the PSG is not written', m.cartPort.psg.register[1] === 0);
  m.write(0xFF90, 0x04);
  m.write(0xFF41, 0x9F);
  check('CoCo 3: SCS on, the PSG is written', m.cartPort.psg.register[1] === 15);
}

// ---------------------------------------------------------------- board choice
{
  check('board: automatic, 16K or less -> Program Pak', Emu.cartridgeFor(new Uint8Array(0x4000)).type === 'rom');
  check('board: automatic, over 16K -> banked', Emu.cartridgeFor(new Uint8Array(0x4001)).type === 'banked');
  // an 8K image forged to carry the Orchestra-90 ROM's CRC (15FB39AF, MAME's ROM table): its last 4 bytes chosen so
  const forged = forgeCrc(new Uint8Array(0x2000).fill(0x39), 0x15FB39AF);
  check('board: automatic, the Orchestra-90 ROM (by CRC) -> Orchestra-90', Emu.crc32(forged) === '15FB39AF' && Emu.cartridgeFor(forged).type === 'orch90');
  check('board: chosen', Emu.cartridgeFor(new Uint8Array(0x100), 'gmc').type === 'gmc' && Emu.cartridgeFor(new Uint8Array(0x100), 'banked').type === 'banked');
  throws('board: empty image refused', () => Emu.cartridgeFor(new Uint8Array(0)), /empty/);
  throws('board: Orchestra-90 holds 8K', () => Emu.cartridgeFor(new Uint8Array(0x2001), 'orch90'), /up to 8K/);
  throws('board: Program Pak holds 32K', () => Emu.cartridgeFor(new Uint8Array(0x8001), 'pak'), /up to 32K/);
  throws('board: banked holds 128K', () => Emu.cartridgeFor(new Uint8Array(0x20001), 'banked'), /up to 128K/);
  throws('board: unknown board refused', () => Emu.cartridgeFor(new Uint8Array(1), 'speech'), /unknown cartridge board/);
}

// ---------------------------------------------------------------- Orchestra-90
{
  const rom = new Uint8Array(0x2000).map((_, i) => (i * 7) & 0xFF);
  const m = coco();
  const o = new Emu.devices.orch90(rom);
  m.insertCartridge(o); m.reset(true);
  check('Orchestra-90: the 8K ROM repeats through $C000-$FEFF', m.read(0xC003) === 21 && m.read(0xE003) === 21 && m.read(0xFEFF) === ((0x1EFF * 7) & 0xFF));
  m.runFrame();
  m.write(0xFF7A, 0x40); m.write(0xFF7B, 0xC0);
  check('Orchestra-90: DACs at $FF7A (left) and $FF7B (right)', o.left === 0x40 && o.right === 0xC0);
  check('Orchestra-90: its sound reaches the machine (both sides summed)', m.cartLevel === (0x40 + 0xC0) / 512, String(m.cartLevel));
  m.runFrame();
  check('Orchestra-90: the frame\'s audio events carry the cartridge level', m.audioEvents[1] >= (0x40 + 0xC0) / 512);
  check('Orchestra-90: CART tied to Q from power-on', o.lines.value('cart') === 'q' && m.cartPort.cartLineFollowsQ);
  check('Orchestra-90: SCS reads 00', m.read(0xFF40) === 0 && m.read(0xFF5F) === 0);
  throws('Orchestra-90 on the MC-10: no cartridge port', () => Emu.createMachine('mc10').insertCartridge(new Emu.devices.orch90(rom)), /no cartridge port/);
}

// ---------------------------------------------------------------- CART and Q
{
  // under mameCompat, every PIA1 write toggles a Q-tied CART five times (zero-delay timers): CB1 sees edges
  const m = coco();
  m.insertCartridge(new Emu.devices.banked(image(1))); m.reset(true);
  for (let f = 0; f < 3; f++) m.runFrame();
  m.write(0xFF23, 0x04); m.read(0xFF22);
  m.runFrame();
  const before = m.pia1.b.irq1;
  m.write(0xFF21, m.read(0xFF21)); m.processEvents(m.cycle + 1);
  check('CART tied to Q (mameCompat): a PIA1 write sets the CB1 flag, nothing else does', before === false && m.pia1.b.irq1 === true);
  // without mameCompat CART follows Q every line instead
  const h = coco({ mameCompat: false });
  h.insertCartridge(new Emu.devices.banked(image(1), { autostart: false })); h.reset(true); h.runFrame();
  h.write(0xFF23, 0x04); h.read(0xFF22); h.runFrame();
  check('CART not tied (auto-start off): no CB1 edges', h.pia1.b.irq1 === false);
}

// ---------------------------------------------------------------- Multi-Pak
{
  throws('Multi-Pak: four slots', () => new Emu.devices.multi([null, null, null, null, null]), /four slots/);
  throws('Multi-Pak: switch 1-4', () => new Emu.devices.multi([], { switchSlot: 5 }), /slots 1-4/);
  throws('Multi-Pak: no Multi-Pak inside a Multi-Pak', () => new Emu.devices.multi([new Emu.devices.multi([])]), /cannot hold another/);
  const m = coco();
  const a = new Emu.devices.banked(image(8)), g = new Emu.devices.gmc(image(4).map((x) => x ^ 0xFF));
  const mp = new Emu.devices.multi([a, null, null, g], { switchSlot: 4 });
  m.insertCartridge(mp); m.reset(true);
  check('Multi-Pak: switch on slot 4 -> $FF7F reads $FF, slot 4\'s ROM shows', m.read(0xFF7F) === 0xFF && m.read(0xC000) === 0xFF);
  m.write(0xFF7F, 0x00);
  check('Multi-Pak: $FF7F reads the selection OR $CC; CTS slot 1 shows its ROM', m.read(0xFF7F) === 0xCC && m.read(0xC000) === 0x00);
  m.write(0xFF7F, 0x20);
  check('Multi-Pak: an empty CTS slot reads 00', m.read(0xC000) === 0x00 && mp.rom() === null);
  m.write(0xFF7F, 0x30); m.write(0xFF40, 3);           // SCS slot 1: its bank register; CTS slot 4 unchanged
  m.write(0xFF7F, 0x00);
  check('Multi-Pak: SCS reaches only the selected slot', m.read(0xC000) === 3 * 16 && g.pos === 0);
  m.write(0xFF7F, 0x33); m.write(0xFF41, 0x9F); m.write(0xFF41, 0x90);
  check('Multi-Pak: the Games Master in slot 4 gets $FF41 when it has SCS', g.psg.volume[0] === 8191);
  m.write(0xFF7F, 0x03);
  m.reset(false);
  check('Multi-Pak: reset returns to the switch position', m.read(0xFF7F) === 0xFF);
  // CART: the CTS slot's line only
  m.runFrame();
  check('Multi-Pak: slot 4 (Q) selected -> CART follows Q', mp.lines.value('cart') === 'q');
  m.write(0xFF7F, 0x23); m.processEvents(m.cycle + 1);
  check('Multi-Pak: an empty slot selected -> CART clear', mp.lines.value('cart') === 'clear');
  // snapshot with the slots
  const snap = Emu.state.fromJSON(Emu.state.toJSON(m.snapshot()));
  const r = Emu.restoreSnapshot(snap, m.roms);
  check('Multi-Pak: restored from a snapshot with its slots and selection', r.cartPort.type === 'multi' && r.cartPort.slots.map((c) => c && c.type).join() === 'banked,,,gmc' && r.read(0xFF7F) === (0x23 | 0xCC));
}

// ---------------------------------------------------------------- the Games Master's stream as the machine runs it
{
  // our product path (the device's Stream, written at each PSG write's time) must give exactly the samples that
  // the chip model gives with the writes placed by the comparison's rule, without the measured MAME delay
  const t = spec.trace('coco', { setup: 'gmc' });
  const m = t.machine();
  const dev = m.cartPort;
  const writes = [], produced = [];
  const w = dev.writeIO.bind(dev);
  dev.writeIO = (a, v) => { if (a === 0xFF41) writes.push({ time: dev.clock.now(), data: v }); w(a, v); };
  const p = dev.stream.produce; dev.stream.produce = (k) => { const v = p(k); produced.push(v); return v; };
  for (let f = 0; f < 90; f++) m.runFrame();
  for (const e of writes) e.index = audio.indexAt(2000000, e.time);
  const psg = new Emu.SN76489();
  const again = audio.chipStream({ write: (e) => psg.write(e.data), sample: () => psg.sample() }, 2000000, writes, produced.length);
  let same = produced.length > 2000000 && writes.length > 20;
  for (let k = 0; k < produced.length && same; k++) if (produced[k] !== again[k]) same = false;
  check('Games Master: the device\'s stream equals the chip model with each write at its first sample', same, `${produced.length} samples, ${writes.length} writes`);
  check('Games Master: the machine\'s audio events carry the PSG', m.audioEvents.length > 4);
}

// ---------------------------------------------------------------- Session
{
  const store = new Map();
  const kv = { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), remove: (k) => store.delete(k), keys: () => [...store.keys()] };
  const s = new Emu.Session({ store: kv });
  s.switchMachine('coco');
  check('Session: the board starts automatic', s.cartBoard === 'auto');
  throws('Session: an unknown board is refused', () => { s.cartBoard = 'speech'; }, /unknown cartridge board/);
  s.cartBoard = 'gmc';
  const msg = s.load('tune.ccc', new Uint8Array(0x8000), { remember: false });
  check('Session: a cartridge image goes on the chosen board', s.machine.cartPort.type === 'gmc' && /Games Master Cartridge inserted/.test(msg), msg);
  s.cartBoard = 'orch90';
  throws('Session: an image too big for the board is refused, naming the file', () => s.load('big.rom', new Uint8Array(0x4000), { remember: false }), /big\.rom: Orchestra-90: .*up to 8K/);
  s.cartBoard = 'auto';
  const mmsg = s.insertMultiPak([{ name: 'a.rom', bytes: new Uint8Array(0x8000), board: 'banked' }, null, { name: 'o.rom', bytes: new Uint8Array(0x2000), board: 'orch90' }], { switchSlot: 1 });
  check('Session: Multi-Pak inserted with its slots', s.machine.cartPort.type === 'multi' && s.machine.read(0xFF7F) === 0xCC && /Multi-Pak \(1: a\.rom, 2: empty, 3: o\.rom\)/.test(mmsg), mmsg);
  throws('Session: a Multi-Pak has four slots', () => s.insertMultiPak([null, null, null, null, null]), /four slots/);
  throws('Session: a bad image in a Multi-Pak names the problem', () => s.insertMultiPak([{ name: 'x', bytes: new Uint8Array(0), board: 'gmc' }]), /Multi-Pak: the cartridge image is empty/);
  // The Multi-Pak is offered where it has been verified against MAME, which today is the Color Computer 1/2 and
  // its clones (`run.js coco --cart multi`). The others are left out for now because they are not verified
  // yet, NOT because MAME lacks the device: MAME 0.264 lists `ext multi` on the Dragons too ("Dragon Multi-Pak
  // Interface"). This table pins every profile's value so a change to the rule, or to a profile's family, cannot
  // silently move the boundary without this failing.
  const MULTI_PAK = {
    // verified: the Multi-Pak was compared here (run.js coco --cart multi)
    coco: true, coco2b: true, mx1600: true, lzcolor64: true, cd6809: true,
    // verified on cloadm-4-cart-machines (run.js dragon32 / dragon64 / coco3 --cart multi, audio included)
    dragon32: true, dragon64: true, coco3: true,
    // cartridge port and the same device in MAME, but no comparison of their own yet
    dragon200: false, tanodr64: false, coco3p: false,
    // not offered until compared with MAME: the Dragon 200-E and the CP 400, a CoCo
    // clone whose Multi-Pak has no comparison of its own
    dragon200e: false, cp400: false,
    // the Dragon 64 Plus: a Dragon 64 cartridge port, but no Multi-Pak comparison of its own
    d64plus: false,
    // no cartridge port at all (their MAME `multi` is a different device: "Fred_72 and 6502man's Multiports Extension")
    mc10: false, alice: false,
    // the Dragon Alpha: a Dragon cartridge port, but no Multi-Pak comparison here yet
    dgnalpha: false,
  };
  for (const [id, want] of Object.entries(MULTI_PAK)) {
    s.switchMachine(id);
    check(`Session: ${id} ${want ? 'takes' : 'takes no'} Multi-Pak (pinned)`, s.hasMultiPak === want, `got ${s.hasMultiPak}`);
  }
  // every profile is in the table above, so a new machine cannot arrive without a decision here
  const profs = Object.keys(Emu.profiles);
  const unlisted = profs.filter((id) => !(id in MULTI_PAK));
  check('Session: every profile has its Multi-Pak answer pinned', unlisted.length === 0, unlisted.join(', '));
  // the reason the Dragons are out is "not verified yet", so the message must say so rather than claim no device
  s.switchMachine('dragon200');
  throws('Session: no Multi-Pak on the Dragon 200, not verified there yet', () => s.insertMultiPak([]), /not verified on the Dragon 200 yet/);
  check('Session: the Dragon 200 still has its cartridge port', s.machine.hasCartridgePort && !s.hasMultiPak);
  s.switchMachine('mc10');
  throws('Session: no Multi-Pak on the MC-10, no cartridge port', () => s.insertMultiPak([]), /needs a cartridge port; the .*MC-10 has none/);
  s.switchMachine('alice');
  throws('Session: no Multi-Pak on the Alice, no cartridge port', () => s.insertMultiPak([]), /needs a cartridge port; the .*Alice.* has none/);
}

// CRC-32 forging: the last 4 bytes chosen so that the whole has the wanted CRC (the CRC run backwards over them)
function forgeCrc(bytes, want) {
  const T = new Uint32Array(256), top = new Uint8Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; top[T[n] >>> 24] = n; }
  let crc = 0xFFFFFFFF;
  for (const b of bytes.subarray(0, bytes.length - 4)) crc = (T[(crc ^ b) & 0xFF] ^ (crc >>> 8)) >>> 0;
  // the register after the 4 bytes must be want ^ FFFFFFFF; undo the 4 steps from there
  let x = (want ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < 4; i++) { const j = top[x >>> 24]; x = (((x ^ T[j]) << 8) | j) >>> 0; }
  // x is now the body's register with the 4 bytes XORed in, low byte first
  const v = (x ^ crc) >>> 0, out = bytes.slice();
  for (let i = 0; i < 4; i++) out[bytes.length - 4 + i] = (v >>> (8 * i)) & 0xFF;
  return out;
}

// ejected while it sounds: the Games Master's level goes to 0, its CART (tied to Q) is let go, and it has no host
{
  const m = coco();
  const g = new Emu.devices.gmc(image(4));
  m.insertCartridge(g); m.reset(false);
  m.write(0xFF41, 0x8A); m.write(0xFF41, 0x00); m.write(0xFF41, 0x90);      // tone 0: period 10, loudest
  for (let i = 0; i < 3; i++) m.runFrame();
  const sounding = m.cartLevel > 0;
  m.ejectCartridge();
  check('eject: a sounding Games Master leaves the cartridge sound at 0', sounding && m.cartLevel === 0, `level ${m.cartLevel}`);
  check('eject: its timer event and handler are gone, it has no host', !m.queue.some((e) => e.name === 'gmc.timer') && !m.handlers['gmc.timer'] && g.host === null);
}
console.log(fail ? `${fail} failed` : 'all passed');
process.exitCode = fail ? 1 : 0;
