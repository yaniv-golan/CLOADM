// The clean-room BASIC's mathematical constants (basic/mathfn.inc), computed here from the constants' decimal
// expansions and exact rationals (BigInt), rounded to nearest in the 5-byte format: pi, ln 2 and sqrt 3 to 36
// digits, Taylor coefficients 1/k!, 1/(2k+1). PIO2HI and LN2HI keep 20 bits, so a multiple up to 4095 of them is
// exact, and PIO2LO and LN2LO are the remainders (Cody and Waite's argument reduction). tools/build-basic.js
// includes the result as "mathconst.inc"; the two tables are the series' coefficients, highest power first (which
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
  out.push('* 1/k!, k = 14 down to 0. EXP: the 12 from 1/11!; COS: Q(-r^2), every other one from 1/14!; SIN: r x P(-r^2),');
  out.push('* every other one from 1/13!');
  for (let k=14;k>=0;k--) out.push(fcb('', packed(1n,fact(BigInt(k))), `1/${k}!`));
  out.push('ODDTAB');
  out.push('* 1/(2k+1), k = 9 down to 0. ATN: x x P(-x^2), all 10; LOG: 2t x P(t^2), the 8 from 1/15');
  for (let k=9;k>=0;k--) out.push(fcb('', packed(1n,BigInt(2*k+1)), `1/${2*k+1}`));
  // the named constants, one block: basic/mathfn.inc numbers them from FPCON for FPRUN's steps
  out.push('FPCON');
  const r=(s)=>dec(s);
  let p=r(PI); const pio2={num:p.num, den:p.den*2n};
  const hi = packed(pio2.num, pio2.den, 20); out.push(fcb('PIO2HI', hi, 'pi/2, 20 bits'));
  // lo = pio2 - hi
  const hiv = (()=>{const b=hi; const m=(BigInt(b[1]|0x80)<<24n)|(BigInt(b[2])<<16n)|(BigInt(b[3])<<8n)|BigInt(b[4]); return {m, e:b[0]-160};})();
  const lo = (() => { // pio2 - m*2^e as rational
    const den = pio2.den * (1n << BigInt(-hiv.e)); const num = pio2.num * (1n << BigInt(-hiv.e)) - hiv.m * pio2.den; return packed(num, den); })();
  out.push(fcb('PIO2LO', lo, 'pi/2 - PIO2HI'));
  out.push(fcb('PIO2', packed(pio2.num,pio2.den), 'pi/2'));
  out.push(fcb('TWOOPI', packed(pio2.den, pio2.num), '2/pi'));
  let l=r(LN2);
  const lhi=packed(l.num,l.den,20); out.push(fcb('LN2HI', lhi, 'ln 2, 20 bits'));
  const lhm=(BigInt(lhi[1]|0x80)<<24n)|(BigInt(lhi[2])<<16n)|(BigInt(lhi[3])<<8n)|BigInt(lhi[4]); const le=-(lhi[0]-160);
  out.push(fcb('LN2LO', packed(l.num*(1n<<BigInt(le)) - lhm*l.den, l.den*(1n<<BigInt(le))), 'ln 2 - LN2HI'));
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
module.exports = { mathConstsInc };
if (require.main === module) process.stdout.write(mathConstsInc());
