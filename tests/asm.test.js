// Run: node tests/asm.test.js
const fs = require('fs'), path = require('path');
const Emu = require('./load')();
let fail = 0, n = 0;
const hex = (a) => [...a].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

// known encodings (from the 6809 datasheet)
const cases = [
  ['LDA #$12', '86 12'], ['LDA $1234', 'B6 12 34'], ['LDA <$12', '96 12'], ['LDA ,X', 'A6 84'],
  ['LDA 5,X', 'A6 05'], ['LDA -1,Y', 'A6 3F'], ['LDA 100,U', 'A6 C8 64'], ['LDA 1000,S', 'A6 E9 03 E8'],
  ['LDA ,X+', 'A6 80'], ['LDA ,X++', 'A6 81'], ['LDA ,-X', 'A6 82'], ['LDA ,--X', 'A6 83'],
  ['LDA A,X', 'A6 86'], ['LDA B,Y', 'A6 A5'], ['LDA D,U', 'A6 CB'], ['LDA [,X]', 'A6 94'],
  ['LDA [$1234]', 'A6 9F 12 34'], ['LDA [5,X]', 'A6 98 05'], ['JSR [$A002]', 'AD 9F A0 02'],
  ['LDX #$1234', '8E 12 34'], ['LDY #$1234', '10 8E 12 34'], ['LDS #$3000', '10 CE 30 00'], ['LDU #1', 'CE 00 01'],
  ['CMPD #1', '10 83 00 01'], ['CMPU $2000', '11 B3 20 00'], ['CMPS ,X', '11 AC 84'], ['STY $10', '10 BF 00 10'],
  ['PSHS A,B,X,Y,U,PC', '34 F6'], ['PULS CC,D,DP', '35 0F'], ['PSHU S', '36 40'], ['TFR X,Y', '1F 12'], ['EXG A,B', '1E 89'],
  ['LEAX 1,X', '30 01'], ['LEAY -1,Y', '31 3F'], ['LEAS 2,S', '32 62'], ['CLR $1234', '7F 12 34'], ['INC ,X', '6C 84'],
  ['NEGA', '40'], ['CLRB', '5F'], ['LSLB', '58'], ['MUL', '3D'], ['SWI2', '10 3F'], ['ANDCC #$FE', '1C FE'],
  ['ORCC #$50', '1A 50'], ['CWAI #$EF', '3C EF'], ['STD ,U++', 'ED C1'], ['ADDD #$100', 'C3 01 00'],
  ["CMPA #'*", '81 2A'], ["CMPA #' ", '81 20'], ['JMP $C000', '7E C0 00'], ['STX [,Y++]', 'AF B1'],
];
for (const [src, want] of cases) {
  n++;
  const r = Emu.assemble('  ORG $1000\n  ' + src + '\n');
  const got = r.ok ? hex(r.segments[0].data) : 'ERR ' + JSON.stringify(r.errors);
  if (got !== want) { fail++; console.log(`FAIL ${src}: got ${got} want ${want}`); }
}
// ---------------- wrong code is an error, never silent (1.20) ----------------
{
  const errs = (src, cpu = '6809') => { const r = Emu.assemble(src, cpu); return r.ok ? null : r.errors.map((e) => `${e.line}: ${e.message}`).join(' | '); };
  const bad = (name, src, re, cpu) => { n++; const e = errs(src, cpu); if (!e || !re.test(e)) { fail++; console.log(`FAIL ${name}: ${e === null ? 'assembled without an error' : e}`); } };
  const good = (name, src, want, cpu = '6809') => {
    n++; const r = Emu.assemble(src, cpu);
    const got = r.ok ? r.segments.map((x) => `${x.addr.toString(16).toUpperCase()}: ${hex(x.data)}`).join(' / ') : 'ERR ' + JSON.stringify(r.errors);
    if (got !== want) { fail++; console.log(`FAIL ${name}: got ${got} want ${want}`); }
  };
  // Motorola's convention: an instruction that takes no operand ends at the mnemonic, so what follows it is a comment
  // (agents and old listings write "LSRA   shift" without a ;); after an operand a comment needs ; since operand
  // expressions may hold spaces ("LDA #1 + 2")
  good('a word after an inherent instruction is a comment', ' ORG $1000\n LSRA            A bit0 = row parity\n NOP wait\n RTS done, back\n', '1000: 44 12 39');
  good('6309: a word after an inherent instruction is a comment', ' ORG $1000\n SEXW  extend W\n NEGD negate\n', '1000: 14 10 40', '6309');
  good('6803: a word after an inherent instruction is a comment', ' ORG $4000\n LSRA shift\n INX next\n', '4000: 44 08', '6803');
  good('a space inside an operand expression still works', ' ORG $1000\n LDA #1 + 2 ; three\n', '1000: 86 03');
  bad('a comment after an operand without ;: the error says so', ' ORG $1000\n LDA #1  load it\n', /^2: junk in expression "1  load it" \(a comment after an operand needs ;\)/);
  bad('an operand after an instruction that takes none is still an error', ' ORG $1000\n LSRA ,X\n', /^2: LSRA takes no operand/);
  bad('6803: a number after ABX is still an error', ' ORG $4000\n ABX 1\n', /^2: ABX takes no operand/, '6803');
  bad('6309: an immediate after SEXW is still an error', ' ORG $1000\n SEXW #1\n', /^2: SEXW takes no operand/, '6309');
  bad('junk with no space in it: no hint', ' ORG $1000\n LDA #1)\n', /^2: junk in expression "1\)"$/);
  // a forward reference in RMB or ORG: the size is not known in pass 1, so every label after it would move
  bad('RMB with a forward reference', ' ORG $1000\n JMP START\nBUF RMB SIZE\nSTART RTS\nSIZE EQU 16\n', /^3: RMB needs a value defined before it/);
  bad('ORG with a forward reference', ' ORG THERE\n JMP *\nTHERE EQU $2000\n', /^1: ORG needs a value defined before it/);
  good('RMB with a value defined before it', 'SIZE EQU 16\n ORG $1000\n JMP START\nBUF RMB SIZE\nSTART RTS\n', '1000: 7E 10 13 / 1013: 39');
  // operands that don't fit
  bad('8-bit immediate too big', ' ORG $1000\n LDA #$1234\n', /^2: .*out of range/);
  bad('8-bit immediate too small', ' ORG $1000\n LDB #-129\n', /^2: .*out of range/);
  bad('16-bit immediate too big', ' ORG $1000\n LDX #$10000\n', /^2: .*out of range/);
  bad('ANDCC immediate too big', ' ORG $1000\n ANDCC #$100\n', /^2: .*out of range/);
  bad('extended address too big', ' ORG $1000\n JMP $12345\n', /^2: .*out of range/);
  bad('16-bit index offset too big', ' ORG $1000\n LDA 70000,X\n', /^2: .*out of range/);
  bad('FCB 300', ' ORG $1000\n FCB 1,300\n', /^2: .*out of range/);
  bad('FDB $12345', ' ORG $1000\n FDB $12345\n', /^2: .*out of range/);
  bad('FCB 1/0', ' ORG $1000\n FCB 1/0\n', /^2: division by zero/);
  bad('RMB -32', ' ORG $1000\n RMB -32\n', /^2: RMB needs a count from 0 to 65535/);
  bad('ORG beyond 64K', ' ORG $10000\n', /^1: ORG needs an address from 0 to \$FFFF/);
  bad('6803: 8-bit immediate too big', ' ORG $4000\n LDAA #256\n', /^2: .*out of range/, '6803');
  bad('6803: 16-bit immediate too big', ' ORG $4000\n LDX #$10000\n', /^2: .*out of range/, '6803');
  bad('6803: extended address too big', ' ORG $4000\n JMP $10000\n', /^2: .*out of range/, '6803');
  good('values at the edges fit', ' ORG $1000\n LDA #-128\n LDB #255\n LDX #-32768\n LDY #$FFFF\n FCB -1,255\n FDB -1\n', '1000: 86 80 C6 FF 8E 80 00 10 8E FF FF FF FF FF FF');
  good('division of a forward symbol is not an error in pass 1', ' ORG $1000\n FCB 10/TWO\nTWO EQU 2\n', '1000: 05');
  // a label defined twice, by a line label or EQU, is an error
  bad('EQU redefines a label', 'X1 EQU 1\nX1 EQU 2\n', /^2: duplicate label X1/);
  bad('a line label redefined by EQU', ' ORG $1000\nL1 NOP\nL1 EQU 5\n', /^3: duplicate label L1/);
  bad('EQU redefined with a forward value', 'X2 EQU LATER\nX2 EQU 3\nLATER EQU 4\n', /^2: duplicate label X2/);
  // FCC with any delimiter
  good('FCC /a,b/', ' ORG $1000\n FCC /a,b/\n', '1000: 61 2C 62');
  good('FCC !x y!, then bytes', ' ORG $1000\n FCC !x y!,13\n', '1000: 78 20 79 0D');
  good('FCS and FCN with a delimiter', ' ORG $1000\n FCS /AB/\n FCN |C|\n', '1000: 41 C2 43 00');
  good('FCC "a,b" still works', ' ORG $1000\n FCC "a,b"\n', '1000: 61 2C 62');
  bad('FCC with no closing delimiter', ' ORG $1000\n FCC /abc\n', /^2: missing closing \/ in FCC/);
}
// branches and PC-relative with labels
{
  n++;
  const r = Emu.assemble(' ORG $1000\nL1 NOP\n BRA L1\n LBRA L1\n BEQ FWD\n LEAX MSG,PCR\nFWD RTS\nMSG FCB "AB",0\n FDB L1\n');
  const want = '12 20 FD 16 FF FA 27 04 30 8D 00 01 39 41 42 00 10 00'; // forward PCR ref -> 16-bit form
  const got = r.ok ? hex(r.segments[0].data) : JSON.stringify(r.errors);
  if (got !== want) { fail++; console.log('FAIL branches: got ' + got + ' want ' + want); }
}
// error reporting
{
  n++;
  // each error names its line and what is wrong
  const r = Emu.assemble(' ORG $1000\n LDA NOWHERE\n FOO\n');
  const want = [[2, /undefined symbol NOWHERE/], [3, /unknown mnemonic FOO/]];
  if (r.ok || r.errors.length !== 2 || !want.every(([line, re]) => r.errors.some((e) => e.line === line && re.test(e.message)))) { fail++; console.log('FAIL errors', r.errors); }
}
// INCLUDE: one shared source file spliced in where the directive is (nesting allowed, cycles refused)
{
  const files = { 'mem.inc': ' FCB 2\n INCLUDE "more.inc"\n', 'more.inc': ' FCB 3\n' };
  const r = Emu.assemble(' ORG $1000\n FCB 1\n INCLUDE "mem.inc"\n FCB 4\n', '6809', { include: (x) => files[x] ?? null });
  n++;
  if (!r.ok || hex(r.segments[0].data) !== '01 02 03 04') { fail++; console.log('FAIL INCLUDE: ' + (r.ok ? hex(r.segments[0].data) : JSON.stringify(r.errors))); }
  n++;
  const m = Emu.assemble(' ORG $1000\n INCLUDE "nope.inc"\n', '6809', { include: () => null });
  if (m.ok || !/INCLUDE nope\.inc/.test(m.errors[0] && m.errors[0].message)) { fail++; console.log('FAIL INCLUDE missing', m.errors); }
  n++;
  const cyc = { 'a.inc': ' INCLUDE "b.inc"\n', 'b.inc': ' INCLUDE "a.inc"\n' };
  const c = Emu.assemble(' ORG $1000\n INCLUDE "a.inc"\n', '6809', { include: (x) => cyc[x] ?? null });
  if (c.ok || !/nested|itself/i.test(c.errors[0] && c.errors[0].message)) { fail++; console.log('FAIL INCLUDE cycle', c.errors); }
  // error locations: an error after an INCLUDE is reported at its own line in the main source, not at its
  // line in the expanded text; one inside an included file names that file and its line
  n++;
  const inc4 = { 'four.inc': ' FCB 1\n FCB 2\n FCB 3\n FCB 4\n' };
  const after = Emu.assemble(' ORG $1000\n INCLUDE "four.inc"\n BADOP\n', '6809', { include: (x) => inc4[x] ?? null });
  const e1 = after.errors[0] || {};
  if (after.ok || e1.line !== 3 || e1.file !== null || !/unknown mnemonic BADOP/.test(e1.message)) {
    fail++; console.log('FAIL INCLUDE error after: ' + JSON.stringify(after.errors));
  }
  n++;
  const inside = Emu.assemble(' ORG $1000\n FCB 0\n INCLUDE "four.inc"\n', '6809',
    { include: (x) => ({ 'four.inc': ' FCB 1\n FCB 2\n BADOP\n FCB 4\n' })[x] ?? null });
  const e2 = inside.errors[0] || {};
  if (inside.ok || e2.line !== 3 || e2.file !== 'four.inc' || !/unknown mnemonic BADOP/.test(e2.message)) {
    fail++; console.log('FAIL INCLUDE error inside: ' + JSON.stringify(inside.errors));
  }
  // a labelled INCLUDE is rejected clearly (it used to say "unknown mnemonic INCLUDE")
  n++;
  const labelled = Emu.assemble(' ORG $1000\nFOO INCLUDE "four.inc"\n', '6809', { include: (x) => inc4[x] ?? null });
  if (labelled.ok || !/INCLUDE takes no label/.test(labelled.errors[0] && labelled.errors[0].message)) {
    fail++; console.log('FAIL INCLUDE labelled', labelled.errors);
  }
  // the listing still points at the expanded lines, with each line's own file and line
  n++;
  const listed = Emu.assemble(' ORG $1000\n INCLUDE "sym.inc"\n NOP\n', '6809', { include: () => ' FDB 1\n' });
  const last = listed.listing[listed.listing.length - 1] || {};
  if (!listed.ok || last.line !== 3 || last.file !== null) { fail++; console.log('FAIL INCLUDE listing', listed.listing); }
}
// NOT a summary line: this file ends with exactly one summary line (below), because tests/all.js reads a suite's
// last line as its summary -- a summary-shaped line here would let a truncation of this file pass the gate, since a
// suite that stops right after one looks finished. Its count is carried into the final line instead, so a failure
// still says which half failed.

// ---- assemble LIZA and hold a conversation on the stub firmware ----
// liza.asm INCLUDEs the conversation data both LIZA builds share (examples/liza-data.inc)
const include = (name) => { const p = path.join(__dirname, '../examples', name); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; };
const src = fs.readFileSync(path.join(__dirname, '../examples/liza.asm'), 'utf8');
const res = Emu.assemble(src, '6809', { include });
if (!res.ok) { console.log('LIZA errors', res.errors); process.exitCode = 1; return; }   // top-level return: stop here, let Node exit
const bin = Emu.toBinary(res, { format: 'dragondos' });
console.log(`liza: ${bin.length - 9} bytes, exec $${res.exec.toString(16)}`);
const m = Emu.createMachine('dragon64');
const d = Emu.formats.identify('liza.bin', bin);
m.injectAndRun(d.segments, d.exec);
const screen = () => {
  let s = '';
  for (let r = 0; r < 16; r++) {
    let l = '';
    for (let c = 0; c < 32; c++) {
      const v = m.ram[0x400 + r * 32 + c], ch = v & 0x3F;
      l += v & 0x80 ? '#' : String.fromCharCode(ch < 0x20 ? ch + 0x40 : ch);
    }
    s += l.replace(/\s+$/, '') + '\n';
  }
  return s;
};
const transcript = [];
const say = (t) => {
  for (const ch of t + '\r') { m.stubKeys.push(ch.toUpperCase().charCodeAt(0)); m.runFrame(); m.runFrame(); }
  for (let i = 0; i < 20; i++) m.runFrame();
  transcript.push(screen());
};
for (let i = 0; i < 20; i++) m.runFrame();
say('Hello');
say('I need a holiday');
say('My boss says I work too much');
say('i think you are a good listener');
let ok = true;
const flat = transcript.join(' ').replace(/\n/g, ' ').replace(/ +/g, ' ');
for (const want of ['HELLO. WHAT WOULD YOU LIKE', 'WHY DO YOU NEED A HOLIDAY?', 'WHY DO YOU SAY YOUR BOSS SAYS YOU WORK TOO MUCH?', 'DO YOU REALLY THINK I AM A GOOD LISTENER?']) {
  if (!flat.includes(want)) { ok = false; console.log(`FAIL LIZA: no "${want}" in the conversation`); }
}
say('i think you are a good listener');
if (!screen().replace(/\n/g, ' ').replace(/ +/g, ' ').includes("DON'T REPEAT")) { ok = false; console.log('FAIL LIZA: no repeat detection'); }
say('bye');
if (!screen().includes('GOODBYE')) { ok = false; console.log('FAIL LIZA: no goodbye'); }
console.log(screen());

// ---------------- assemble-time defines and IF/ENDIF ----------------
// One source can be built two ways: `defines` pre-seeds a symbol, and IF/ENDIF (with ELSE) includes a block
// only when its expression is non-zero. The welcome program's comparison build uses this to assemble a
// HALT that the shipping build does not have.
{
  const src = '  ORG $1000\n  IF DEBUG\n  LDA #1\n  ELSE\n  LDA #2\n  ENDIF\n  RTS\n';
  const withFlag = Emu.assemble(src, '6809', { defines: { DEBUG: 1 } });
  const without = Emu.assemble(src, '6809', { defines: { DEBUG: 0 } });
  n++;
  if (!(withFlag.ok && hex(withFlag.segments[0].data) === '86 01 39')) { fail++; console.log(`FAIL IF with the flag: ${withFlag.ok ? hex(withFlag.segments[0].data) : JSON.stringify(withFlag.errors)}`); }
  n++;
  if (!(without.ok && hex(without.segments[0].data) === '86 02 39')) { fail++; console.log(`FAIL IF with the flag 0: ${without.ok ? hex(without.segments[0].data) : JSON.stringify(without.errors)}`); }
  // An undefined symbol in an IF is an ERROR, not a false: a misspelled flag must not build the wrong
  // variant silently. The message names the symbol.
  const typo = Emu.assemble('  ORG $1000\n  IF DEUBG\n  LDA #1\n  ENDIF\n  RTS\n', '6809', { defines: {} });
  n++;
  if (typo.ok || !/DEUBG/.test(typo.errors.map((e) => e.message).join(' '))) { fail++; console.log(`FAIL a misspelled flag was not an error naming the symbol: ${typo.ok ? 'accepted' : JSON.stringify(typo.errors)}`); }
  // a flag left out altogether is the same error, never a silent false
  const missing = Emu.assemble('  ORG $1000\n  IF DEBUG\n  LDA #1\n  ENDIF\n  RTS\n', '6809', { defines: {} });
  n++;
  if (missing.ok) { fail++; console.log('FAIL an undefined IF symbol was accepted as false'); }
  // nested IFs close the right one
  const nest = '  ORG $1000\n  IF A\n  IF B\n  LDA #1\n  ELSE\n  LDA #2\n  ENDIF\n  ENDIF\n  RTS\n';
  const nested = Emu.assemble(nest, '6809', { defines: { A: 1, B: 0 } });
  n++;
  if (!(nested.ok && hex(nested.segments[0].data) === '86 02 39')) { fail++; console.log(`FAIL nested IF: ${nested.ok ? hex(nested.segments[0].data) : JSON.stringify(nested.errors)}`); }
  // a define can be a bare name, as a command line would pass it
  const named = Emu.assemble('  ORG $1000\n  IF DEBUG\n  LDA #1\n  ENDIF\n  RTS\n', '6809', { defines: ['DEBUG'] });
  n++;
  if (!(named.ok && hex(named.segments[0].data) === '86 01 39')) { fail++; console.log(`FAIL a bare define name: ${named.ok ? hex(named.segments[0].data) : JSON.stringify(named.errors)}`); }
  // an unterminated IF is an error, not a silent truncation
  const bad = Emu.assemble('  ORG $1000\n  IF A\n  LDA #1\n', '6809', { defines: { A: 1 } });
  n++;
  if (bad.ok) { fail++; console.log('FAIL an unterminated IF was accepted'); }
}

// ---------------- IF: the line number in the error, a comment after the condition, and EQU over a define
// Each case asserts the exact message AND the line, because line 0 was what made
// the original reports unusable: it pointed at no line at all.
{
  const one = (src, opts) => {
    const r = Emu.assemble(src, '6809', opts);
    return r.ok ? 'ACCEPTED' : r.errors.map((e) => `${e.line}: ${e.message}`).join(' | ');
  };
  const want = (name, src, re, opts) => {
    n++;
    const got = one(src, opts);
    if (!re.test(got)) { fail++; console.log(`FAIL ${name}: got "${got}"`); }
  };
  // An IF whose condition is bad must name ITS OWN line. Before the fix every one of these reported line 0,
  // which is not a line of the source at all - and the four structural errors did too.
  want('IF with a division by zero names the IF line', '  ORG $1000\n  IF 1/0\n  LDA #1\n  ENDIF\n', /^2: division by zero$/);
  want('IF with an undefined symbol names the IF line', '  ORG $1000\n  NOP\n  IF NOPE\n  LDA #1\n  ENDIF\n', /^3: undefined symbol NOPE$/);
  want('IF with a junk condition names the IF line', '  ORG $1000\n  IF )(\n  LDA #1\n  ENDIF\n', /^2: bad expression/);
  // the structural errors carry the line of the directive that is guilty
  want('ELSE without IF names its own line', '  ORG $1000\n  NOP\n  ELSE\n', /^3: ELSE without IF$/);
  want('ENDIF without IF names its own line', '  ORG $1000\n  NOP\n  ENDIF\n', /^3: ENDIF without IF$/);
  want('an unterminated IF names the IF that was never closed',
    '  ORG $1000\n  NOP\n  IF 1\n  LDA #1\n', /^3: IF without ENDIF$/);
  // A comment after the condition is a comment, exactly as it is after an instruction: "IF DEBUG ; why" is
  // the most natural way anyone writes a build flag, and it must not be read as part of the expression.
  want('IF with a comment after a true condition assembles', '  ORG $1000\n  IF 1 ; always\n  LDA #1\n  ENDIF\n', /^ACCEPTED$/, {});
  want('IF with a comment after a define assembles', '  ORG $1000\n  IF DEBUG ; the comparison build\n  LDA #1\n  ENDIF\n',
    /^ACCEPTED$/, { defines: { DEBUG: 1 } });
  // and the condition still decides: a false one with a comment keeps its block out
  {
    const r = Emu.assemble('  ORG $1000\n  IF DEBUG ; the comparison build\n  LDA #1\n  ELSE\n  LDA #2\n  ENDIF\n', '6809', { defines: { DEBUG: 0 } });
    n++;
    if (!(r.ok && hex(r.segments[0].data) === '86 02')) { fail++; console.log(`FAIL IF with a comment, false flag: ${r.ok ? hex(r.segments[0].data) : JSON.stringify(r.errors)}`); }
  }
  // EQU over a name the caller defined is a contradiction, not an override: `defines` is how a build is told
  // what it is, and a source that then says otherwise is disagreeing with its own command line.
  want('EQU over a define is an error naming both', 'X EQU 3\n  ORG $1000\n  LDA #X\n', /^1: X is already defined by the caller/,
    { defines: { X: 5 } });
  want('EQU over a bare-name define is the same error', 'X EQU 3\n', /^1: X is already defined by the caller/, { defines: ['X'] });
  // a name the caller did NOT define is still free for the source to EQU, and the value is the source's
  {
    const r = Emu.assemble('X EQU 3\n  ORG $1000\n  LDA #X\n', '6809', { defines: { Y: 5 } });
    n++;
    if (!(r.ok && hex(r.segments[0].data) === '86 03')) { fail++; console.log(`FAIL EQU over an unrelated define: ${r.ok ? hex(r.segments[0].data) : JSON.stringify(r.errors)}`); }
  }
  // A CODE LABEL of the same name is the same contradiction, and it used to win in silence: a source label
  // sets `symbols` without the pass-1 duplicate test ever asking who had defined the name.
  want('a code label over a define is an error naming both', '  ORG $1000\nDEBUG NOP\n  LDA #1\n',
    /^2: DEBUG is already defined by the caller/, { defines: { DEBUG: 5 } });
  want('a code label over a bare-name define is the same error', '  ORG $1000\nDEBUG NOP\n',
    /^2: DEBUG is already defined by the caller/, { defines: ['DEBUG'] });
  // and a label the caller did not define still takes its address as usual
  {
    const r = Emu.assemble('  ORG $1000\nDEBUG NOP\n  LDA #1\n', '6809', { defines: { OTHER: 1 } });
    n++;
    if (!(r.ok && r.symbols.get('DEBUG') === 0x1000)) { fail++; console.log(`FAIL a code label beside an unrelated define: ${r.ok ? r.symbols.get('DEBUG') : JSON.stringify(r.errors)}`); }
  }
}

// The file's ONE summary line, and its last output. Every ASSEMBLER check above is counted in n and fail, and the
// LIZA conversation beside it is not: it is a handful of screen checks with a single ok flag, and folding them into
// a count that says "assembler checks" would misdescribe them. So the summary names both halves and says which
// failed, and a LIZA failure prints its own "FAIL LIZA: ..." line in the gate's one failure shape rather than
// leaving a reader to work it out from the summary's last word.
//
// Written as one line on purpose: a second summary-shaped line earlier in the file would let the gate pass a
// truncation of this suite.
//
// The failure wording counts the FAILURES first ("3/109 assembler checks failed"), never the passes: the other way
// round read as "the 108 checks failed". No failure line here matches a summary pattern -- "failed" is not "passed",
// and the gate also fails the suite on its exit code and on any "FAIL " line, whatever it exits with -- which
// tests/allsummary.test.js pins by running this very branch and checking the gate's verdict.
if (fail || !ok) {
  const parts = [];
  if (fail) parts.push(`${fail}/${n} assembler checks failed`);
  if (!ok) parts.push('LIZA conversation FAILED');
  console.log(parts.join('; '));
} else console.log(`${n}/${n} checks passed (assembler and LIZA)`);
process.exitCode = fail || !ok ? 1 : 0;
