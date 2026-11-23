// The QR Code encoder (js/media/qr.js) the Share screen draws the short link with.
//  * ISO/IEC 18004:2015 Annex I's worked example: "01234567" at version 1-M gives the data codewords
//    10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11 and the error correction codewords A5 24 D4 C1 ED 36 C7 87 2C 55
//  * the format information (Annex C, Table C.1) and version information (Annex D, Table D.1) values
//  * every symbol read back by a reader written here (format bits from both copies, the mask undone, the modules read in
//    placement order, blocks de-interleaved, Reed-Solomon checked by syndromes): the text comes back, at every level
//    and version a short link uses, with every mask
//  * the function patterns where the standard puts them, and a text too long for version 10 refused
const Emu = require('./load')();
const q = Emu;

let fail = 0;
const check = (name, cond, detail = '') => { if (!cond) { fail++; console.log(`FAIL ${name} ${detail}`); } else console.log(`ok   ${name} ${detail}`); };
const hex = (a) => Buffer.from(a).toString('hex');

// ---------------- the standard's worked example ----------------
{
  const r = q.qrCodewords('01234567', { ecl: 'M' });
  check('Annex I: "01234567" is version 1', r.version === 1);
  check('Annex I: the data codewords', hex(r.data) === '10200c566180ec11ec11ec11ec11ec11', hex(r.data));
  check('Annex I: the error correction codewords', hex(r.codewords.subarray(16)) === 'a524d4c1ed36c7872c55', hex(r.codewords.subarray(16)));
}
// ---------------- format and version information ----------------
{
  // Table C.1, mask 0 of each level, and two more
  const want = { L0: '111011111000100', M0: '101010000010010', Q0: '011010101011111', H0: '001011010001001', M5: '100000011001110', L7: '110100101110110' };
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, q.formatBits(k[0], Number(k[1])).toString(2).padStart(15, '0')]));
  check('format information (Table C.1)', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  check('version information (Table D.1): versions 7 and 10', q.versionBits(7).toString(2).padStart(18, '0') === '000111110010010100'
    && q.versionBits(10).toString(2).padStart(18, '0') === '001010010011010011');
}

// ---------------- a reader of its own ----------------
const gmul = (x, y) => { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; };
// a codeword block is valid when its polynomial vanishes at alpha^0 .. alpha^(ec-1)
const syndromesZero = (block, ec) => {
  let a = 1;
  for (let i = 0; i < ec; i++) { let s = 0; for (const b of block) s = gmul(s, a) ^ b; if (s) return false; a = gmul(a, 2); }
  return true;
};
const BLOCKS = { // [ec, [blocks, data], ...] for the versions read here (Table 9), written out again rather than imported
  '1M': [10, [1, 16]], '2M': [16, [1, 28]], '3M': [26, [1, 44]], '4M': [18, [2, 32]], '5M': [24, [2, 43]], '6M': [16, [4, 27]], '7M': [18, [4, 31]],
  '3L': [15, [1, 55]], '6H': [28, [4, 15]], '4L': [20, [1, 80]], '4Q': [26, [2, 24]], '4H': [16, [4, 9]], '5Q': [18, [2, 15], [2, 16]], '7H': [26, [4, 13], [1, 14]], '10M': [26, [4, 43], [1, 44]],
};
const LEVEL = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };
function read(sym) {
  const { size, modules } = sym, at = (r, c) => modules[r * size + c];
  const v = (size - 17) / 4;
  // the format bits, both copies (Figure 25)
  let f1 = 0, f2 = 0;
  const p1 = [[0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8], [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0]];
  p1.forEach(([r, c], i) => { f1 |= at(r, c) << i; });
  for (let i = 0; i < 8; i++) f2 |= at(8, size - 1 - i) << i;
  for (let i = 8; i < 15; i++) f2 |= at(size - 15 + i, 8) << i;
  if (f1 !== f2) throw new Error('the two format copies differ');
  const fmt = f1 ^ 0x5412, ecl = LEVEL[fmt >> 13], mask = (fmt >> 10) & 7;
  if (q.formatBits(ecl, mask) !== f1) throw new Error('format bits fail their BCH check');
  if (!at(size - 8, 8)) throw new Error('no dark module');
  // the modules in placement order, unmasked, skipping the function patterns
  const { fn } = q.qrTemplate(v), bits = [];
  for (const [r, c] of q.qrDataOrder(v, fn)) bits.push(at(r, c) ^ (q.MASKS[mask](r, c) ? 1 : 0));
  const total = Math.floor(bits.length / 8), cw = [];
  for (let i = 0; i < total; i++) cw.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  const [ec, ...groups] = BLOCKS[`${v}${ecl}`];
  const lens = groups.flatMap(([n, d]) => Array(n).fill(d)), blocks = lens.map(() => []);
  let k = 0;
  for (let i = 0; i < Math.max(...lens); i++) lens.forEach((d, b) => { if (i < d) blocks[b].push(cw[k++]); });
  for (let i = 0; i < ec; i++) blocks.forEach((b) => b.push(cw[k++]));
  if (!blocks.every((b) => syndromesZero(b, ec))) throw new Error('a block fails its Reed-Solomon check');
  const data = blocks.flatMap((b, i) => b.slice(0, lens[i]));
  const dbits = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (b >> s) & 1));
  let p = 0;
  const take = (n) => { let x = 0; for (let i = 0; i < n; i++) x = (x << 1) | dbits[p++]; return x; };
  const mode = take(4);
  if (mode === 4) { const n = take(v < 10 ? 8 : 16); return { ecl, mask, v, text: new TextDecoder().decode(Uint8Array.from({ length: n }, () => take(8))) }; }
  if (mode === 1) {
    const n = take(v < 10 ? 10 : 12); let t = '';
    for (let i = 0; i < n; i += 3) { const g = Math.min(3, n - i); t += String(take([0, 4, 7, 10][g])).padStart(g, '0'); }
    return { ecl, mask, v, text: t };
  }
  throw new Error(`mode ${mode}`);
}

{
  const link = 'https://s.cloadm.dev/AbC-_dEf#0123456789abcdefghijkl';
  const cases = [[link, 'M'], [link, 'L'], [link, 'Q'], [link, 'H'], ['01234567', 'M'], ['https://cloadm.dev/play/?machine=coco3&cpu=6809&ram=512#z=AQ', 'M'], ['x'.repeat(190), 'M'], ['é ü ✓', 'M']];
  for (const [text, ecl] of cases) {
    const bad = [];
    for (let mask = 0; mask < 8; mask++) {
      const sym = q.qrEncode(text, { ecl, mask });
      let r; try { r = read(sym); } catch (e) { bad.push(`${mask}: ${e.message}`); continue; }
      if (r.text !== text || r.ecl !== ecl || r.mask !== mask) bad.push(`${mask}: ${JSON.stringify(r).slice(0, 60)}`);
    }
    const best = q.qrEncode(text, { ecl });
    check(`read back, every mask: ${text.slice(0, 24)}… at ${ecl} (version ${best.version})`, !bad.length, bad.join('; '));
  }
  const s = q.qrEncode(link);
  check('a short link: version 4 at level M, 33 x 33, the mask with the lowest penalty',
    s.version === 4 && s.size === 33 && Array.from({ length: 8 }, (_, m) => q.qrPenalty(q.qrEncode(link, { mask: m }).modules, 33)).every((p) => p >= q.qrPenalty(s.modules, 33)));
  // function patterns: the three finders (7x7, dark ring, light ring, dark 3x3), timing, the alignment pattern at 26,26
  const at = (r, c) => s.modules[r * 33 + c];
  const finder = (r0, c0) => [0, 1, 2, 3, 4, 5, 6].every((r) => [0, 1, 2, 3, 4, 5, 6].every((c) => at(r0 + r, c0 + c) === (Math.max(Math.abs(r - 3), Math.abs(c - 3)) !== 2 ? 1 : 0)));
  check('the finder patterns, timing patterns and alignment pattern', finder(0, 0) && finder(0, 26) && finder(26, 0)
    && Array.from({ length: 17 }, (_, i) => at(6, 8 + i) === ((8 + i) % 2 === 0 ? 1 : 0) && at(8 + i, 6) === ((8 + i) % 2 === 0 ? 1 : 0)).every(Boolean)
    && at(26, 26) === 1 && at(25, 26) === 0 && at(24, 26) === 1);
  let e = null; try { q.qrEncode('x'.repeat(400)); } catch (err) { e = err; }
  check('too long for version 10: refused, saying so', e instanceof q.QrError && /do not fit a version 10/.test(e.message), e && e.message);
}

console.log(fail ? `${fail} FAILED` : 'all passed');
process.exitCode = fail ? 1 : 0;
