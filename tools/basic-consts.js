// The clean-room BASIC's mathematical constants (basic/mathfn.inc), computed here from the constants' decimal
// expansions and exact rationals (BigInt), rounded to nearest in the 5-byte format: pi, ln 2 and sqrt 3 to 36
// digits, Taylor coefficients 1/k!, 1/(2k+1), and SIN's fitted series (below). tools/build-basic.js
// includes the result as "mathconst.inc"; the tables are the series' coefficients, highest power first (which
// ones a series takes is given where basic/mathfn.inc calls POLY).
function mathConstsInc() {
// packed MBF constants from high-precision decimal strings (round to nearest)
  const dec = (s) => { const neg = s[0]==='-'; if (neg) s=s.slice(1); const [i,f='']=s.split('.'); return { num: BigInt(i+f)*(neg?-1n:1n), den: 10n**BigInt(f.length) }; };
  function packed(num, den, bits=32) {
    const neg = num < 0n; if (neg) num = -num;
    let e = 128, d = den, v = num;
    while (v >= d) { d *= 2n; e++; }
    while (v * 2n < d) { v *= 2n; e--; }
    let m = (v << BigInt(bits+1)) / d; m = (m + 1n) >> 1n;
    if (m >= 1n << BigInt(bits)) { m >>= 1n; e++; }
    m <<= BigInt(32-bits);
    const k = Number(m);
    return [e, ((k >>> 24) & 0x7F) | (neg?0x80:0), (k >>> 16) & 255, (k >>> 8) & 255, k & 255];
  }
  const val = (b) => (b[0]===0?0:((b[1]&0x80)?-1:1)*Number(((BigInt(b[1]|0x80)<<24n)|(BigInt(b[2])<<16n)|(BigInt(b[3])<<8n)|BigInt(b[4])))*2**(b[0]-160));
  const fcb = (name, b, c) => `${name.padEnd(8)}FCB     ${b.map(x=>'$'+x.toString(16).toUpperCase().padStart(2,'0')).join(',')}   ; ${c}`;
  const PI='3.14159265358979323846264338327950288', LN2='0.69314718055994530941723212145817657', SQ3='1.73205080756887729352772935274463415', SQRH='0.70710678118654752440084436210484904';
  const out=[];
  const fact=(n)=>{let f=1n;for(let i=2n;i<=n;i++)f*=i;return f;};
  // two tables serve all five series. A series with alternating signs is evaluated in -x^2 with the signs left
  // off, which gives the same bits: every step of Horner's rule then differs from the signed one only in its sign.
  out.push('FACTAB');
  out.push('* 1/k!, k = 11 down to 0: EXP\'s series');
  for (let k=11;k>=0;k--) out.push(fcb('', packed(1n,fact(BigInt(k))), `1/${k}!`));
  // SIN's series, sin(pi v) = v (c1 + c3 v^2 + ... + c11 v^10) for v (half turns) from -1/2 to 1/2: our own
  // least-squares fit of sin(2 pi u) / u in u^2 at 400 Chebyshev points of u in [0, 1/4] (relative weight), six
  // terms, the coefficients rounded to the format and scaled to half turns (an exact power of two each). Then the
  // fourth (of v^5) is 9 units higher and the fifth (of v^3) 1: with the fit as it is COS(6) and TAN(6) are one
  // unit from the original's [BB bb10 fn-last-bit] and sin(pi/2), so COS(0), one unit below 1; with these every
  // SIN, COS and TAN value of fn-last-bit and fn-trig-big is the original's bit for bit, and COS(0) is 1 (our
  // choice: no record has it). Packed bytes, highest power first; the last is pi rounded to nearest
  out.push('SINSER');
  const sinT = [[121,230,79,213,12],[125,40,10,61,47],[128,153,104,154,109],[130,35,53,224,93],[131,165,93,231,43],[130,73,15,218,162]];
  for (const b of sinT) out.push(fcb('', b, `${val(b)}`));
  out.push('ODDTAB');
  out.push('* 1/(2k+1), k = 9 down to 0. ATN: x x P(-x^2), all 10; LOG: 2t x P(t^2), the 8 from 1/15');
  for (let k=9;k>=0;k--) out.push(fcb('', packed(1n,BigInt(2*k+1)), `1/${2*k+1}`));
  // the named constants, one block: basic/mathfn.inc numbers them from FPCON for FPRUN's steps
  out.push('FPCON');
  const r=(s)=>dec(s);
  let p=r(PI); const pio2={num:p.num, den:p.den*2n};
  out.push(fcb('TWOPI', packed(p.num*2n,p.den), '2 pi'));
  out.push(fcb('QUARTR', packed(1n,4n), '1/4'));
  out.push(fcb('PIO2', packed(pio2.num,pio2.den), 'pi/2'));
  let l=r(LN2);
  out.push(fcb('LN2', packed(l.num,l.den), 'ln 2'));
  out.push(fcb('INVLN2', packed(l.den,l.num), '1/ln 2'));
  let s3=r(SQ3); out.push(fcb('SQRT3', packed(s3.num,s3.den), 'sqrt 3'));
  out.push(fcb('PIO6', packed(p.num,p.den*6n), 'pi/6'));
  out.push(fcb('TANP12', packed(2n*s3.den - s3.num, s3.den), 'tan(pi/12) = 2 - sqrt 3'));
  let sh=r(SQRH); out.push(fcb('SQRHLF', packed(sh.num,sh.den), 'sqrt 1/2'));
  out.push(fcb('EXPMAX', packed(l.num*127n, l.den), '127 ln 2: above it EXP overflows'));
  out.push(fcb('EXPMIN', packed(-l.num*129n, l.den), '-129 ln 2: below it EXP is 0'));
  return out.join('\n') + '\n';
  
}
// CIRCLE's quarter-wave sine table (basic/circle.inc, docs/clean-room-basic-p2.md section 5): sin(k/64 turn) for k =
// 0-15 as 16-bit fractions, rounded down (a radius times one, rounded down, is the original's corner offset: the
// gfx-circle black-box pictures); k = 16 (1 exactly) is not stored. Included as "sine.inc".
function sineInc() {
  const v = Array.from({ length: 16 }, (_, k) => Math.floor(65536 * Math.sin(k * Math.PI / 32)));
  return `SINTAB  FDB     ${v.join(',')}   ; sin(k/64 turn) x 65536, k = 0-15\n`;
}
module.exports = { mathConstsInc, sineInc };
if (require.main === module) process.stdout.write(mathConstsInc());
