// cloadm --expect-screenshot (with --tolerance and --diff) and --hold.
// The reference PNGs here are made by this test's own encoder, not the tool's: colour types 2 (RGB), 3 (palette),
// 0 (grey) and 6 (RGBA), with every PNG filter type, and grey and palette packed at 1, 2 and 4 bits (rows that end
// part way through a byte, a grey tRNS), so the tool's decoder is checked against files it did not write.
//   identical picture -> exit 0, 0 differing; one pixel changed -> exit 1 (expect-failed), the count is 1 and the
//   first difference names that pixel and both colours; --tolerance 1 lets it pass; --diff draws it red and the
//   rest at a third of the frame; a size mismatch, a file that is not a PNG, a missing file and an unsupported PNG
//   are the right errors.
//   --hold: a program that counts the frames in which it sees a key down in the matrix; held N frames it counts N;
//   unknown keys and bad syntax are usage errors.
// Run: node tests/cli-screenshot.test.js
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name}`); };
const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli', 'cloadm.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cloadm-shot-'));
const tmp = (n) => path.join(TMP, n);
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
  let json = null;
  if (args.includes('--json')) { try { json = JSON.parse(r.stdout); } catch (e) { json = null; } }
  return { code: r.status, out: r.stdout, err: r.stderr, json };
}

// ---- an independent PNG encoder: any colour type, a filter per row chosen in turn ----
function crc(buf) { return zlib.crc32(buf) >>> 0; }
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// samples: one byte per sample, w x h x channels (in the colour type's layout); depth under 8 (grey or palette) packs
// them, high bits first, each row padded to a whole byte. The filters work on the packed bytes, `unit` bytes a pixel.
function encode(w, h, colour, samples, { plte = null, trns = null, depth = 8, filters = [0, 1, 2, 3, 4] } = {}) {
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour], stride = Math.ceil(w * ch * depth / 8), unit = Math.max(1, ch * depth / 8);
  const rows = Buffer.alloc(stride * h);
  if (depth === 8) samples.copy(rows, 0, 0, stride * h);
  else for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rows[y * stride + ((x * depth) >> 3)] |= samples[y * w + x] << (8 - depth - ((x * depth) & 7));
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = filters[y % filters.length];
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const cur = rows[y * stride + x], a = x >= unit ? rows[y * stride + x - unit] : 0, b = y ? rows[(y - 1) * stride + x] : 0;
      const c = x >= unit && y ? rows[(y - 1) * stride + x - unit] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      raw[y * (stride + 1) + 1 + x] = (cur - pred) & 0xFF;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = colour;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr),
    ...(plte ? [chunk('PLTE', plte)] : []), ...(trns ? [chunk('tRNS', trns)] : []), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// a PNG decoder for what the tool writes (8-bit RGBA, any filter), to read --diff
function decodeRgba(buf) {
  let at = 8, w = 0, h = 0;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? px[y * stride + x - 4] : 0, b = y ? px[(y - 1) * stride + x] : 0, c = x >= 4 && y ? px[(y - 1) * stride + x - 4] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      px[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f]) & 0xFF;
    }
  }
  return { w, h, px };
}

// ---- the picture: the colour demo's colour bars on a Dragon 64, as the tool's --screenshot gives it (read back
// with this test's decoder) ----
const STEPS = ['--program', 'demo', '--frames', '100', '--type', ' ', '--frames', '20'];
check('the demo runs to its colour bars', cli([...STEPS, '--screenshot', tmp('ref.png')]).code === 0);
const ref = decodeRgba(fs.readFileSync(tmp('ref.png'))), W = ref.w, H = ref.h, rgba = ref.px;
const rgb = Buffer.alloc(W * H * 3);
for (let i = 0; i < W * H; i++) rgba.copy(rgb, i * 3, i * 4, i * 4 + 3);
const colours = new Set();
for (let i = 0; i < W * H; i++) colours.add(rgb.readUIntBE(i * 3, 3));
check(`the reference frame has several colours (${colours.size}) and every alpha is 255`, colours.size >= 4 && [...Array(W * H).keys()].every((i) => rgba[i * 4 + 3] === 255));
fs.writeFileSync(tmp('same-rgb.png'), encode(W, H, 2, rgb));
fs.writeFileSync(tmp('same-rgba.png'), encode(W, H, 6, rgba, { filters: [4, 3, 2, 1, 0] }));
// the same picture as a palette PNG
const pal = [...colours], index = new Map(pal.map((c, i) => [c, i]));
const plte = Buffer.alloc(pal.length * 3);
pal.forEach((c, i) => plte.writeUIntBE(c, i * 3, 3));
const idx = Buffer.alloc(W * H);
for (let i = 0; i < W * H; i++) idx[i] = index.get(rgb.readUIntBE(i * 3, 3));
fs.writeFileSync(tmp('same-palette.png'), encode(W, H, 3, idx, { plte }));
// and packed: the smallest palette depth that holds the colours (the frame has at most 16)
const packed = pal.length <= 2 ? 1 : pal.length <= 4 ? 2 : 4;
check(`the frame's ${pal.length} colours fit a ${packed}-bit palette`, pal.length <= 16);
fs.writeFileSync(tmp(`same-palette-${packed}bit.png`), encode(W, H, 3, idx, { plte, depth: packed }));

// identical pictures, in three PNG layouts
for (const f of ['same-rgb.png', 'same-rgba.png', 'same-palette.png', `same-palette-${packed}bit.png`]) {
  const r = cli([...STEPS, '--expect-screenshot', tmp(f), '--json']);
  const st = r.json && r.json.steps.find((x) => x.step === 'expect-screenshot');
  check(`${f}: the same picture -> exit 0, 0 pixels differ`, r.code === 0 && st && st.differing === 0 && st.met === true && st.width === W && st.height === H, r.err || JSON.stringify(st));
}
// the tool's own screenshot as the reference
{
  const r = cli([...STEPS, '--screenshot', tmp('own.png'), '--expect-screenshot', tmp('own.png')]);
  check('the tool\'s own --screenshot as the reference -> exit 0', r.code === 0, r.err);
}

// one pixel changed
const PX = 123, PY = 45, o = (PY * W + PX) * 3;
const one = Buffer.from(rgb);
one[o] ^= 0x40;
fs.writeFileSync(tmp('one.png'), encode(W, H, 2, one));
const hex = (b, i) => `#${[b[i], b[i + 1], b[i + 2]].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('')}FF`;
{
  const r = cli([...STEPS, '--expect-screenshot', tmp('one.png'), '--json']);
  const e = r.json && r.json.error;
  check('one pixel changed -> exit 1, expect-failed', r.code === 1 && e && e.code === 'expect-failed', r.err);
  check('the error counts 1 differing pixel and names it with both colours', e && e.screenshot && e.screenshot.differing === 1
    && e.screenshot.first.x === PX && e.screenshot.first.y === PY && e.screenshot.first.expected === hex(one, o) && e.screenshot.first.actual === hex(rgb, o),
  e && JSON.stringify(e.screenshot));
  check('the message says how many and where', e && /1 pixel differs/.test(e.message) && e.message.includes(`(${PX},${PY})`), e && e.message);
  const h = cli([...STEPS, '--expect-screenshot', tmp('one.png')]);
  check('without --json: exit 1 and the message on stderr', h.code === 1 && /1 pixel differs from .*one\.png \(tolerance 0\)/.test(h.err), h.err);
}
// the tolerance
{
  const r = cli([...STEPS, '--tolerance', '1', '--expect-screenshot', tmp('one.png'), '--json']);
  const st = r.json && r.json.steps.find((x) => x.step === 'expect-screenshot');
  check('--tolerance 1: one differing pixel passes, and the result still counts it', r.code === 0 && st.differing === 1 && st.tolerance === 1 && st.first.x === PX, r.err);
  const two = Buffer.from(one);
  two[o + 3 * 7 + 1] ^= 0x10;
  fs.writeFileSync(tmp('two.png'), encode(W, H, 2, two));
  const t = cli([...STEPS, '--tolerance', '1', '--expect-screenshot', tmp('two.png'), '--json']);
  check('--tolerance 1: two differing pixels fail, counted 2', t.code === 1 && t.json.error.screenshot.differing === 2, t.err);
  const bad = cli([...STEPS, '--tolerance', 'x', '--json']);
  check('--tolerance x: exit 2', bad.code === 2 && bad.json.error.code === 'bad-argument');
}
// the difference picture
{
  const r = cli([...STEPS, '--diff', tmp('diff.png'), '--expect-screenshot', tmp('one.png'), '--json']);
  const d = decodeRgba(fs.readFileSync(tmp('diff.png')));
  let ok = d.w === W && d.h === H, red = 0;
  for (let i = 0; i < W * H && ok; i++) {
    const p = d.px.subarray(i * 4, i * 4 + 4);
    if (i === PY * W + PX) { ok = p[0] === 255 && p[1] === 0 && p[2] === 0 && p[3] === 255; red++; } else ok = [0, 1, 2].every((k) => p[k] === Math.floor(rgba[i * 4 + k] / 3)) && p[3] === 255;
  }
  check('--diff: the differing pixel red, every other the frame at a third', r.code === 1 && ok && red === 1 && r.json.error.screenshot.diff === tmp('diff.png'));
}
// size mismatch, not a PNG, missing, unsupported
{
  fs.writeFileSync(tmp('small.png'), encode(4, 3, 0, Buffer.alloc(12, 0x80)));
  const r = cli([...STEPS, '--expect-screenshot', tmp('small.png'), '--json']);
  check('a reference of another size -> exit 1, both sizes in the message', r.code === 1 && r.json.error.code === 'expect-failed' && r.json.error.message.includes(`${W}x${H}`) && r.json.error.message.includes('4x3'));
  fs.writeFileSync(tmp('text.png'), 'not a picture');
  const t = cli([...STEPS, '--expect-screenshot', tmp('text.png'), '--json']);
  check('a file that is not a PNG -> exit 3, bad-media', t.code === 3 && t.json.error.code === 'bad-media');
  const m = cli([...STEPS, '--expect-screenshot', tmp('nothing.png'), '--json']);
  check('a missing reference -> exit 3, cannot-read', m.code === 3 && m.json.error.code === 'cannot-read');
  const png16 = encode(2, 2, 0, Buffer.alloc(4));
  png16[8 + 8 + 8] = 16;   // IHDR bit depth 16, CRC left stale
  fs.writeFileSync(tmp('damaged.png'), png16);
  const c = cli([...STEPS, '--expect-screenshot', tmp('damaged.png'), '--json']);
  check('a damaged PNG (bad CRC) -> exit 3, bad-media', c.code === 3 && c.json.error.code === 'bad-media' && /CRC/.test(c.json.error.message));
  const deep = encode(2, 2, 0, Buffer.alloc(4));
  deep[24] = 16;
  deep.writeUInt32BE(zlib.crc32(deep.subarray(12, 29)) >>> 0, 29);
  fs.writeFileSync(tmp('deep.png'), deep);
  const u = cli([...STEPS, '--expect-screenshot', tmp('deep.png'), '--json']);
  check('a 16-bit PNG -> exit 3, bad-media, saying what is supported', u.code === 3 && u.json.error.code === 'bad-media' && /grey or palette at 1, 2, 4 or 8 bits/.test(u.json.error.message), u.json && u.json.error.message);
}

// ---- grey and palette under 8 bits ----
{
  // a whole-frame grey reference at 1 and 2 bits: every pixel the given grey, so the first difference names it
  const grey = (depth, v, trns) => {
    const f = tmp(`grey${depth}.png`);
    fs.writeFileSync(f, encode(W, H, 0, Buffer.alloc(W * H, v), { depth, trns }));
    const r = cli([...STEPS, '--tolerance', String(W * H), '--expect-screenshot', f, '--json']);
    return r.json && r.json.steps.find((x) => x.step === 'expect-screenshot');
  };
  const g1 = grey(1, 1), g2 = grey(2, 2), g4 = grey(4, 5, Buffer.from([0, 5]));
  check('a 1-bit grey reference reads as white (#FFFFFFFF)', g1 && g1.first && g1.first.expected === '#FFFFFFFF' && g1.differing === W * H, JSON.stringify(g1 && g1.first));
  check('a 2-bit grey reference reads 2 as #AAAAAA', g2 && g2.first && g2.first.expected === '#AAAAAAFF');
  check('a 4-bit grey reference with tRNS: the transparent grey 5 reads as #55555500', g4 && g4.first && g4.first.expected === '#55555500');
  // the decoder on small images whose rows end part way through a byte, against values worked out by hand
  const { decodePng } = require(CLI);
  const px = (d, i) => Array.from(d.rgba.subarray(i * 4, i * 4 + 4));
  const a = decodePng(encode(3, 2, 0, Buffer.from([1, 0, 1, 0, 1, 1]), { depth: 1, filters: [1, 2] }), 'a.png');
  check('1-bit grey, 3 x 2 (rows padded): 1 0 1 / 0 1 1', a.width === 3 && a.height === 2
    && [255, 0, 255, 0, 255, 255].every((v, i) => px(a, i).join() === `${v},${v},${v},255`));
  const plte = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
  const b = decodePng(encode(5, 3, 3, Buffer.from([0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 3, 3, 2, 2, 1]), { depth: 2, plte, filters: [4, 3, 0] }), 'b.png');
  const want = [0, 1, 2, 3, 3, 2, 1, 0, 0, 1, 3, 3, 2, 2, 1];
  check('2-bit palette, 5 x 3 (Paeth, average, none): each pixel its palette colour', want.every((k, i) => px(b, i).join() === `${plte[k * 3]},${plte[k * 3 + 1]},${plte[k * 3 + 2]},255`));
  const c = decodePng(encode(3, 1, 0, Buffer.from([0, 7, 15]), { depth: 4 }), 'c.png');
  check('4-bit grey: 0, 7, 15 -> 0, 119, 255', [0, 119, 255].every((v, i) => px(c, i)[0] === v));
  let err = null;
  const rgb4 = encode(2, 2, 2, Buffer.alloc(12));
  rgb4[24] = 4;                                                   // IHDR bit depth 4, with its CRC made right
  rgb4.writeUInt32BE(zlib.crc32(rgb4.subarray(12, 29)) >>> 0, 29);
  try { decodePng(rgb4, 'x.png'); } catch (e) { err = e; }
  check('a 4-bit RGB PNG (not a valid PNG layout) is refused, bad-media', err && err.code === 'bad-media' && /the other colour types at 8/.test(err.message), err && err.message);
}

// ---- --hold ----
// HELD counts the frames in which the program sees column 6 row 5 down (RIGHT on the Dragon); one look per frame,
// after the field sync
const HOLD = `
        ORG     $3000
START   ORCC    #$50
        LDA     #$34
        STA     $FF03           ; PIA0 CB1 (FS) flag, no interrupt
        CLR     HELD
LOOP    LDA     $FF02           ; clear the FS flag
WFS     LDA     $FF03
        BPL     WFS
        LDA     #%10111111      ; column 6
        STA     $FF02
        LDA     $FF00
        BITA    #%00100000      ; row 5
        BNE     LOOP
        INC     HELD
        BRA     LOOP
HELD    FCB     0
        END     START
`;
fs.writeFileSync(tmp('hold.asm'), HOLD);
{
  const r = cli(['--asm', tmp('hold.asm'), '--frames', '3', '--hold', 'RIGHT:7', '--frames', '5', '--json']);
  const held = r.json && r.json.steps.find((x) => x.step === 'hold');
  const a = r.json && r.json.steps.find((x) => x.step === 'asm').symbols.HELD;
  const p = cli(['--asm', tmp('hold.asm'), '--frames', '3', '--hold', 'RIGHT:7', '--frames', '5', '--peek', String(a), '--json']);
  check('hold RIGHT:7: the program sees the key in exactly 7 frames, and not after', r.code === 0 && held.frames === 7 && held.keys.join() === 'RIGHT'
    && p.json.steps.find((x) => x.step === 'peek').bytes[0] === 7, r.err);
  const b = cli(['--asm', tmp('hold.asm'), '--frames', '3', '--hold', '{right}', '--peek', String(a), '--json']);
  check('hold {right}: braces and lower case, 1 frame by default', b.code === 0 && b.json.steps.find((x) => x.step === 'peek').bytes[0] === 1, b.err);
  const c = cli(['--asm', tmp('hold.asm'), '--frames', '3', '--hold', 'LEFT+UP:4', '--peek', String(a), '--json']);
  check('hold LEFT+UP:4 (other keys): the program does not count them', c.code === 0 && c.json.steps.find((x) => x.step === 'peek').bytes[0] === 0
    && c.json.steps.find((x) => x.step === 'hold').keys.join() === 'LEFT,UP');
  const u = cli(['--asm', tmp('hold.asm'), '--hold', 'F1:2', '--json']);
  check('hold F1 on a Dragon (no such key): exit 2, untypable', u.code === 2 && u.json.error.code === 'untypable' && /no F1 key/.test(u.json.error.message));
  const z = cli(['--asm', tmp('hold.asm'), '--hold', 'RIGHT:0', '--json']);
  check('hold RIGHT:0: exit 2, bad-argument', z.code === 2 && z.json.error.code === 'bad-argument');
  const e = cli(['--asm', tmp('hold.asm'), '--hold', '', '--json']);
  check('hold with nothing: exit 2', e.code === 2);
  const d = JSON.parse(cli(['--describe']).out);
  check('--describe lists expect-screenshot, tolerance, diff and hold', ['expect-screenshot', 'tolerance', 'diff', 'hold'].every((n) => d.steps.some((x) => x.name === n)));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
